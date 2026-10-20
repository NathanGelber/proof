//! The KYC profile vault: the single source of truth for entity data.
//!
//! On disk it is one encrypted file (the profile, as JSON) plus a folder of encrypted
//! documents next to it. Nothing in this module touches the network.
//!
//! Layout of the vault file (all integers little-endian):
//!   magic "PRFKYC01" | m_cost u32 | t_cost u32 | p_cost u32 | salt [16]
//!   | wrap_nonce [24] | wrapped data key [32 + 16 tag]
//!   | body_nonce [24] | body ciphertext (+16 tag)
//! The passphrase derives a key-encryption key with Argon2id. That key wraps a random
//! data key, which encrypts the profile and every document. Changing the passphrase only
//! re-wraps the data key. The header is authenticated as associated data.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"PRFKYC01";
const DOC_MAGIC: &[u8; 8] = b"PRFDOC01";
const HEADER_LEN: usize = 8 + 12 + 16; // magic, params, salt
const WRAP_LEN: usize = 24 + 32 + 16;
const BODY_START: usize = HEADER_LEN + WRAP_LEN;
pub const IDLE_LOCK: Duration = Duration::from_secs(15 * 60);

/// Argon2id cost: 64 MiB, 3 passes. Roughly half a second on an ordinary laptop.
const M_COST: u32 = 64 * 1024;
const T_COST: u32 = 3;
const P_COST: u32 = 1;

pub struct Vault {
    pub path: PathBuf,
    key: Option<Zeroizing<[u8; 32]>>,
    /// Header plus wrapped key, reused on every save.
    head: Vec<u8>,
    /// The profile JSON while unlocked.
    data: Option<Zeroizing<String>>,
    /// Exact bytes last read or written, to detect edits made elsewhere (e.g. a shared folder).
    on_disk: Vec<u8>,
    last_use: Instant,
}

fn rand<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

fn kek(pass: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pass.as_bytes(), salt, &mut *out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    let nonce: [u8; 24] = rand();
    let ct = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| "Encryption failed".to_string())?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(out)
}

fn open(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, ()> {
    if sealed.len() < 24 + 16 {
        return Err(());
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(&sealed[..24]), Payload { msg: &sealed[24..], aad })
        .map(Zeroizing::new)
        .map_err(|_| ())
}

/// Rules for a new passphrase. Existing profiles with older, shorter passphrases still open.
pub fn check_new_pass(p: &str) -> Result<(), String> {
    let n = p.chars().count();
    if n < 12 {
        return Err("Use a passphrase of at least 12 characters. A few unrelated words works well.".into());
    }
    let distinct: std::collections::HashSet<char> = p.to_lowercase().chars().collect();
    if distinct.len() < 6 || p.chars().all(|c| c.is_ascii_digit()) {
        return Err("That passphrase is too easy to guess. Use a few unrelated words.".into());
    }
    let low = p.to_lowercase();
    for common in ["password", "wachtwoord", "passphrase", "qwerty", "123456", "letmein", "welcome", "proof"] {
        let squashed = low.replace([' ', '-', '_', '.'], "");
        if squashed.starts_with(common) && squashed.chars().count() - common.chars().count() < 8 {
            return Err("That passphrase is too easy to guess. Use a few unrelated words.".into());
        }
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("proof-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't replace {}: {e}", path.display())
    })
}

fn valid_doc_id(id: &str) -> Result<(), String> {
    let ok = (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(()) } else { Err("Invalid document id".into()) }
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Vault { path, key: None, head: vec![], data: None, on_disk: vec![], last_use: Instant::now() }
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn docs_dir(&self) -> PathBuf {
        let mut name = self.path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(".files");
        self.path.with_file_name(name)
    }

    /// Locks if idle too long. Returns true while unlocked.
    pub fn check(&mut self) -> bool {
        if self.key.is_some() && self.last_use.elapsed() > IDLE_LOCK {
            self.lock();
        }
        self.key.is_some()
    }

    pub fn touch(&mut self) -> Result<(), String> {
        if !self.check() {
            return Err("LOCKED: The profile is locked.".into());
        }
        self.last_use = Instant::now();
        Ok(())
    }

    pub fn lock(&mut self) {
        self.key = None;
        self.data = None;
        self.head.clear();
    }

    pub fn create(&mut self, pass: &str, initial: &str) -> Result<(), String> {
        check_new_pass(pass)?;
        if self.exists() {
            return Err(format!("A profile already exists at {}.", self.path.display()));
        }
        let salt: [u8; 16] = rand();
        let k = kek(pass, &salt, M_COST, T_COST, P_COST)?;
        let dek = Zeroizing::new(rand::<32>());
        let mut head = MAGIC.to_vec();
        for v in [M_COST, T_COST, P_COST] {
            head.extend(v.to_le_bytes());
        }
        head.extend(salt);
        let wrapped = seal(&k, &head, &*dek)?;
        head.extend(wrapped);
        self.head = head;
        self.key = Some(dek);
        self.last_use = Instant::now();
        self.write(initial)
    }

    fn parse_head(bytes: &[u8]) -> Result<(u32, u32, u32), String> {
        if bytes.len() < BODY_START + 40 || &bytes[..8] != MAGIC {
            return Err("That file isn't a Proof profile, or it's damaged.".into());
        }
        let u = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        Ok((u(8), u(12), u(16)))
    }

    pub fn unlock(&mut self, pass: &str) -> Result<String, String> {
        let bytes = std::fs::read(&self.path).map_err(|e| format!("Couldn't read the profile: {e}"))?;
        let (m, t, p) = Self::parse_head(&bytes)?;
        if m > 1024 * 1024 || t > 20 || p > 16 {
            return Err("The profile's header is damaged.".into());
        }
        let salt = &bytes[20..36];
        let k = kek(pass, salt, m, t, p)?;
        let dek_v = open(&k, &bytes[..HEADER_LEN], &bytes[HEADER_LEN..BODY_START])
            .map_err(|_| "WRONGPASS: That passphrase didn't work.".to_string())?;
        let mut dek = Zeroizing::new([0u8; 32]);
        dek.copy_from_slice(&dek_v);
        let body = open(&dek, &bytes[..BODY_START], &bytes[BODY_START..])
            .map_err(|_| "The profile is damaged and can't be decrypted.".to_string())?;
        let text = Zeroizing::new(String::from_utf8(body.to_vec()).map_err(|_| "The profile is damaged.".to_string())?);
        self.head = bytes[..BODY_START].to_vec();
        self.key = Some(dek);
        self.on_disk = bytes;
        self.data = Some(text.clone());
        self.last_use = Instant::now();
        Ok(text.to_string())
    }

    pub fn get(&mut self) -> Result<String, String> {
        self.touch()?;
        Ok(self.data.as_ref().map(|d| d.to_string()).unwrap_or_default())
    }

    /// The profile JSON for the scrubber. Does not count as activity.
    pub fn data(&self) -> Option<&str> {
        self.data.as_ref().map(|d| d.as_str())
    }

    pub fn save(&mut self, json: &str, force: bool) -> Result<(), String> {
        self.touch()?;
        serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("Not valid profile data: {e}"))?;
        if !force {
            let now = std::fs::read(&self.path).unwrap_or_default();
            if now != self.on_disk {
                return Err("CONFLICT: The profile file was changed by someone or something else since you opened it.".into());
            }
        }
        self.write(json)
    }

    fn write(&mut self, json: &str) -> Result<(), String> {
        let key = self.key.as_ref().ok_or("LOCKED: The profile is locked.")?;
        let mut out = self.head.clone();
        out.extend(seal(key, &self.head, json.as_bytes())?);
        write_atomic(&self.path, &out)?;
        self.on_disk = out;
        self.data = Some(Zeroizing::new(json.to_string()));
        Ok(())
    }

    pub fn change_pass(&mut self, old: &str, new: &str) -> Result<(), String> {
        self.touch()?;
        check_new_pass(new)?;
        let u = |i: usize| u32::from_le_bytes(self.head[i..i + 4].try_into().unwrap());
        let (m, t, p) = (u(8), u(12), u(16));
        let k_old = kek(old, &self.head[20..36], m, t, p)?;
        open(&k_old, &self.head[..HEADER_LEN], &self.head[HEADER_LEN..BODY_START])
            .map_err(|_| "WRONGPASS: The current passphrase is wrong.".to_string())?;
        let salt: [u8; 16] = rand();
        let k = kek(new, &salt, M_COST, T_COST, P_COST)?;
        let mut head = MAGIC.to_vec();
        for v in [M_COST, T_COST, P_COST] {
            head.extend(v.to_le_bytes());
        }
        head.extend(salt);
        let dek = self.key.clone().ok_or("LOCKED: The profile is locked.")?;
        head.extend(seal(&k, &head, &*dek)?);
        self.head = head;
        let json = self.data.as_ref().map(|d| d.to_string()).unwrap_or_default();
        self.write(&json)
    }

    pub fn put_doc(&mut self, id: &str, bytes: &[u8]) -> Result<(), String> {
        self.touch()?;
        valid_doc_id(id)?;
        let key = self.key.as_ref().unwrap();
        let mut aad = DOC_MAGIC.to_vec();
        aad.extend(id.as_bytes());
        let mut out = DOC_MAGIC.to_vec();
        out.extend(seal(key, &aad, bytes)?);
        write_atomic(&self.docs_dir().join(format!("{id}.bin")), &out)
    }

    pub fn get_doc(&mut self, id: &str) -> Result<Vec<u8>, String> {
        self.touch()?;
        valid_doc_id(id)?;
        let raw = std::fs::read(self.docs_dir().join(format!("{id}.bin"))).map_err(|e| format!("Couldn't read the document: {e}"))?;
        if raw.len() < 8 || &raw[..8] != DOC_MAGIC {
            return Err("The stored document is damaged.".into());
        }
        let mut aad = DOC_MAGIC.to_vec();
        aad.extend(id.as_bytes());
        open(self.key.as_ref().unwrap(), &aad, &raw[8..])
            .map(|z| z.to_vec())
            .map_err(|_| "The stored document is damaged and can't be decrypted.".to_string())
    }

    pub fn delete_doc(&mut self, id: &str) -> Result<(), String> {
        self.touch()?;
        valid_doc_id(id)?;
        let p = self.docs_dir().join(format!("{id}.bin"));
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("Couldn't delete the document: {e}"))?;
        }
        Ok(())
    }

    /// Copy the encrypted profile and its documents into `dest` (still encrypted).
    pub fn backup(&mut self, dest: &Path) -> Result<String, String> {
        self.touch()?;
        let name = self.path.file_name().ok_or("Bad profile path")?;
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        std::fs::copy(&self.path, dest.join(name)).map_err(|e| format!("Couldn't copy the profile: {e}"))?;
        let docs = self.docs_dir();
        let mut n = 0;
        if docs.is_dir() {
            let to = dest.join(docs.file_name().unwrap());
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            for e in std::fs::read_dir(&docs).map_err(|e| e.to_string())?.flatten() {
                if e.path().extension().map(|x| x == "bin").unwrap_or(false) {
                    std::fs::copy(e.path(), to.join(e.file_name())).map_err(|e| e.to_string())?;
                    n += 1;
                }
            }
        }
        Ok(format!("{}", n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("proof-vault-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("kyc.vault")
    }

    #[test]
    fn roundtrip_and_wrong_pass() {
        let p = tmp("rt");
        let mut v = Vault::new(p.clone());
        v.create("correct horse battery", r#"{"a":1}"#).unwrap();
        v.save(r#"{"a":2}"#, false).unwrap();
        v.put_doc("doc-12345678", b"%PDF-1.7 hello").unwrap();
        v.lock();
        assert!(v.get().is_err());
        let mut w = Vault::new(p.clone());
        assert!(w.unlock("wrong passphrase!").unwrap_err().starts_with("WRONGPASS"));
        assert_eq!(w.unlock("correct horse battery").unwrap(), r#"{"a":2}"#);
        assert_eq!(w.get_doc("doc-12345678").unwrap(), b"%PDF-1.7 hello");
        assert!(w.get_doc("../etc/passwd").is_err());
        let raw = std::fs::read(&p).unwrap();
        assert!(!raw.windows(5).any(|x| x == b"\"a\":2"));
    }

    #[test]
    fn passphrase_rules() {
        assert!(check_new_pass("short").is_err());
        assert!(check_new_pass("111111111111").is_err());
        assert!(check_new_pass("aaaaaaaaaaaaaa").is_err());
        assert!(check_new_pass("Password1234").is_err());
        assert!(check_new_pass("correct horse battery").is_ok());
    }

    #[test]
    fn change_pass_keeps_docs() {
        let p = tmp("cp");
        let mut v = Vault::new(p.clone());
        v.create("first passphrase", "{}").unwrap();
        v.put_doc("doc-abcdefgh", b"bytes").unwrap();
        assert!(v.change_pass("not it at all", "second passphrase").is_err());
        v.change_pass("first passphrase", "second passphrase").unwrap();
        let mut w = Vault::new(p);
        assert!(w.unlock("first passphrase").is_err());
        w.unlock("second passphrase").unwrap();
        assert_eq!(w.get_doc("doc-abcdefgh").unwrap(), b"bytes");
    }

    #[test]
    fn detects_outside_change() {
        let p = tmp("cf");
        let mut a = Vault::new(p.clone());
        a.create("shared passphrase", "{}").unwrap();
        let mut b = Vault::new(p.clone());
        b.unlock("shared passphrase").unwrap();
        b.save(r#"{"by":"b"}"#, false).unwrap();
        assert!(a.save(r#"{"by":"a"}"#, false).unwrap_err().starts_with("CONFLICT"));
        a.save(r#"{"by":"a"}"#, true).unwrap();
    }

    #[test]
    fn tampering_fails() {
        let p = tmp("tm");
        let mut a = Vault::new(p.clone());
        a.create("shared passphrase", r#"{"x":"y"}"#).unwrap();
        let mut raw = std::fs::read(&p).unwrap();
        let n = raw.len();
        raw[n - 3] ^= 1;
        std::fs::write(&p, raw).unwrap();
        let mut b = Vault::new(p);
        assert!(b.unlock("shared passphrase").is_err());
    }
}
