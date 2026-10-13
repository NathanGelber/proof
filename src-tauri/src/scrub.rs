//! Last line of defence before anything leaves the machine: every outgoing string is checked
//! against the values in the unlocked profile, and any match is cut out.
//!
//! Matching ignores case, spacing and punctuation, so "NL 1234.56.789" in a form label is
//! caught by a stored "nl123456789". Short and long values are handled differently: a value of
//! up to six words (a name, an address line, an identifier) is also matched word by word, so
//! "Northwind" alone is caught when "Northwind Holding B.V." is stored.

use serde_json::Value;

const MIN_LEN: usize = 4;
const TOKEN_MIN: usize = 5;
const SKIP: &[&str] = &["yes", "no", "true", "false", "none", "n/a", "na", "nvt"];
const COMMON: &[&str] = &[
    "cooperatief", "coöperatief", "cooperative", "group", "groep", "holding", "holdings", "limited",
    "company", "corporation", "international", "trading", "capital", "partners", "services",
    "management", "beheer", "investments", "street", "straat", "avenue", "netherlands", "nederland",
    "amsterdam", "rotterdam", "europe", "european", "united", "states", "kingdom", "director",
    "member", "members", "fund", "funds", "bank", "financial", "finance", "markets",
];

/// Words in a counterparty's name that also appear in ordinary form labels.
const TERM_COMMON: &[&str] = &["clearing", "client", "clients", "onboarding", "form", "kyc", "know", "your", "customer", "services", "securities", "asset", "assets", "private", "global", "investment", "investor", "account", "accounts", "prime", "brokerage", "custody", "depositary", "trust"];

pub struct Scrubber {
    needles: Vec<Vec<char>>,
}

/// Lowercase and drop accents, so "Société" and "Societe" compare equal.
fn fold(c: char) -> impl Iterator<Item = char> {
    c.to_lowercase().map(|l| match l {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ý' | 'ÿ' => 'y',
        'ç' => 'c',
        'ñ' => 'n',
        x => x,
    })
}

fn compact(s: &str) -> Vec<char> {
    s.chars().flat_map(fold).filter(|c| c.is_alphanumeric()).collect()
}

fn collect(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            let enumerated = m.get("e").and_then(|e| e.as_bool()).unwrap_or(false);
            for (k, x) in m {
                if (k == "v" || k == "value") && !enumerated {
                    if let Some(s) = x.as_str() {
                        out.push(s.to_string());
                    }
                }
                collect(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect(x, out)),
        _ => {}
    }
}

impl Scrubber {
    pub fn from_profile(json: &str) -> Scrubber {
        let mut raw = vec![];
        if let Ok(v) = serde_json::from_str::<Value>(json) {
            if let Some(ents) = v.get("entities").and_then(|e| e.as_array()) {
                for e in ents {
                    if let Some(n) = e.get("name").and_then(|n| n.as_str()) {
                        raw.push(n.to_string());
                    }
                    collect(e, &mut raw);
                }
            }
            if let Some(log) = v.get("log") {
                collect(log, &mut raw);
            }
        }
        let mut needles: Vec<Vec<char>> = vec![];
        let mut add = |c: Vec<char>| {
            if c.len() >= MIN_LEN && !needles.contains(&c) {
                needles.push(c);
            }
        };
        for s in raw {
            let t = s.trim();
            if SKIP.contains(&t.to_lowercase().as_str()) {
                continue;
            }
            add(compact(t));
            // ISO dates also appear as DDMMYYYY or MMDDYYYY on forms.
            let b = t.as_bytes();
            if b.len() == 10 && b[4] == b'-' && b[7] == b'-' && t.chars().filter(|c| c.is_ascii_digit()).count() == 8 {
                let (y, m, d) = (&t[0..4], &t[5..7], &t[8..10]);
                add(format!("{d}{m}{y}").chars().collect());
                add(format!("{m}{d}{y}").chars().collect());
            }
            let words: Vec<&str> = t.split_whitespace().collect();
            if words.len() > 1 && words.len() <= 6 {
                for w in words {
                    let c = compact(w);
                    let lw: String = c.iter().collect();
                    if c.len() >= TOKEN_MIN && !COMMON.contains(&lw.as_str()) {
                        add(c);
                    }
                }
            }
        }
        // Longest first, so a full value is removed before its parts.
        needles.sort_by(|a, b| b.len().cmp(&a.len()));
        Scrubber { needles }
    }

    /// Also cut these terms (e.g. the counterparty's name), and their distinctive words.
    pub fn add_terms(&mut self, terms: &[String]) {
        for t in terms {
            let c = compact(t);
            if c.len() >= MIN_LEN && !self.needles.contains(&c) {
                self.needles.push(c);
            }
            for w in t.split_whitespace() {
                let c = compact(w);
                let lw: String = c.iter().collect();
                if c.len() >= MIN_LEN && !COMMON.contains(&lw.as_str()) && !TERM_COMMON.contains(&lw.as_str()) && !self.needles.contains(&c) {
                    self.needles.push(c);
                }
            }
        }
        self.needles.sort_by(|a, b| b.len().cmp(&a.len()));
    }

    /// Returns the text with profile values replaced by "[…]", and how many were removed.
    pub fn scrub(&self, text: &str) -> (String, usize) {
        if self.needles.is_empty() || text.is_empty() {
            return (text.to_string(), 0);
        }
        let chars: Vec<char> = text.chars().collect();
        // Compacted haystack, with the original char index of each compacted char.
        let mut hay: Vec<char> = vec![];
        let mut at: Vec<usize> = vec![];
        for (i, c) in chars.iter().enumerate() {
            for l in fold(*c) {
                if l.is_alphanumeric() {
                    hay.push(l);
                    at.push(i);
                }
            }
        }
        let mut cut = vec![false; chars.len()];
        let mut hits = 0;
        for n in &self.needles {
            if n.len() > hay.len() {
                continue;
            }
            let mut i = 0;
            while i + n.len() <= hay.len() {
                if hay[i..i + n.len()] == n[..] {
                    let (a, b) = (at[i], at[i + n.len() - 1]);
                    if !cut[a..=b].iter().all(|x| *x) {
                        hits += 1;
                    }
                    cut[a..=b].iter_mut().for_each(|x| *x = true);
                    i += n.len();
                } else {
                    i += 1;
                }
            }
        }
        if hits == 0 {
            return (text.to_string(), 0);
        }
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            if cut[i] {
                out.push_str("[…]");
                while i < chars.len() && cut[i] {
                    i += 1;
                }
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        (out, hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = r#"{"entities":[{"name":"Northwind Holding B.V.","values":{
        "kvk":{"v":"NL 8123.4567"},"incorporated":{"v":"2019-03-14"},
        "pep":{"v":"no"},"country":{"v":"NL","e":true},
        "street":{"v":"Herengracht 500","hist":[{"v":"Keizersgracht 12"}]}},
        "people":[{"values":{"full_name":{"v":"Jan de Vries"}}}]}],
        "log":[{"fields":[{"label":"x","value":"ABNANL2A"}]}]}"#;

    #[test]
    fn removes_values_and_variants() {
        let s = Scrubber::from_profile(P);
        let (o, n) = s.scrub("Company: Northwind Holding B.V., reg no nl81234567, founded 14/03/2019");
        assert!(!o.to_lowercase().contains("northwind"), "{o}");
        assert!(!o.contains("8123"), "{o}");
        assert!(!o.contains("2019"), "{o}");
        assert!(n >= 3);
        let (o, _) = s.scrub("Previous address Keizersgracht 12; contact de Vries; BIC abnanl2a");
        assert!(!o.contains("Keizersgracht") && !o.contains("Vries") && !o.to_lowercase().contains("abnanl2a"), "{o}");
    }

    #[test]
    fn leaves_ordinary_labels_alone() {
        let s = Scrubber::from_profile(P);
        for l in ["Is any director a PEP? Yes / No", "Country of incorporation", "Registered address (street, number)", "NL tax residency"] {
            assert_eq!(s.scrub(l), (l.to_string(), 0));
        }
    }
}
