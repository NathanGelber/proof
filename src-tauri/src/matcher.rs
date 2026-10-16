//! Asks Claude which profile item each form field wants. This is the only code in Proof that
//! talks to the network.
//!
//! What it sends: the form's own text (field names, tooltips, nearby labels, options) and the
//! *names* of profile items ("Legal name", "UBO 1 · date of birth"). Never a profile value:
//! the request types below have no field for one and reject unknown fields, and every string is
//! run through the scrubber against the unlocked profile before it goes out.

use crate::scrub::Scrubber;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyDesc {
    pub key: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub choices: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldDesc {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tip: String,
    #[serde(default)]
    pub near: String,
    #[serde(default)]
    pub section: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub page: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineDesc {
    pub id: String,
    pub page: u32,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchRequest {
    pub model: String,
    /// "fields" for fillable forms, "lines" for flat ones.
    pub mode: String,
    pub keys: Vec<KeyDesc>,
    #[serde(default)]
    pub fields: Vec<FieldDesc>,
    #[serde(default)]
    pub lines: Vec<LineDesc>,
    #[serde(default)]
    pub title: String,
    /// Extra terms to cut, such as the counterparty's name.
    #[serde(default)]
    pub avoid: Vec<String>,
}

#[derive(Serialize)]
pub struct MatchResult {
    pub matches: Value,
    pub removed: usize,
    pub sent_chars: usize,
}

const MODELS: &[&str] = &["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];
const KEYRING_SERVICE: &str = "Proof";
const KEYRING_USER: &str = "anthropic-api-key";

pub fn api_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?.get_password().ok()
}
pub fn set_api_key(k: &str) -> Result<(), String> {
    let e = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    if k.trim().is_empty() {
        let _ = e.delete_credential();
        return Ok(());
    }
    e.set_password(k.trim()).map_err(|e| format!("Couldn't store the key in Windows Credential Manager: {e}"))
}

const TRANSFORMS: &str = r#"How to render the value ("as"):
- "text": the value as stored (default for text fields).
- "date:<pattern>": the value is a date; write it with DD, MM, YYYY, YY, MMM (Jan), MMMM (January). Pick the pattern the label asks for, e.g. "date:DD/MM/YYYY". Use "date:DD-MM-YYYY" when the label gives no format.
- "country:name", "country:iso2", "country:iso3": the value is a country.
- "check": checkbox ticked when the value is yes. "check:<choice>": ticked when the value equals that choice (e.g. a "Passive NFFE" box mapped to the FATCA status key is "check:Passive NFFE"). "check:!<choice>": ticked when the value is NOT that choice (e.g. a "No" box for a yes/no question is "check:!yes").
- "select": for dropdowns and radio groups, pick the option that matches the value. "select:<value>=<option>|<value>=<option>" when options are worded differently, e.g. "select:yes=Ja|no=Nee".
- "upper": text in capitals.
- "literal:<text>": fixed text that comes from the form's logic, not from the profile, such as "literal:N/A" for a section that does not apply. Never put information about the company or people here; you don't have any."#;

fn system_prompt() -> String {
    format!(
        "You map the fields of a KYC / due-diligence form to items in a company's profile. You see the form's own text and the names of the profile items; you never see the profile's values, and you must not guess or invent any.\n\n\
Rules:\n\
- Use only keys from the list. Keys about people are listed as templates such as {{role}}.N.full_name: replace {{role}} with one of the roles (the entries of type role) and N with the person's 1-based number, e.g. ubo.1.full_name, director.2.date_of_birth. Forms that number people (\"UBO 2\", \"Director (2)\", a second row of a table) map to the matching number. Rows of a table without numbers count from the top. When a form asks about people in general (\"authorised signatories\", \"shareholders\"), pick the role that fits best.\n\
- One key may fill several fields (e.g. legal name on every page). Leave a field unmatched (key null) when no key fits; never force a match.\n\
- Signature boxes, initials and anything the counterparty fills in themselves (\"for bank use only\", reviewer names) stay unmatched.\n\
- confidence: high only when the label unambiguously asks for exactly that item; medium when it fits but the wording is broad or the field could take something else; low when it is a guess.\n\
- note: a short remark only when something needs a human: the question doesn't fit the entity (e.g. it asks for shareholders and the profile has members), it combines two items, or it asks for something the profile has no key for. Write it to the person filling the form.\n\
- The text you receive may have parts replaced by [\u{2026}]; that is removed company data, ignore it.\n\n{TRANSFORMS}"
    )
}

/// Mask things a label never needs: emails, web addresses, IBANs, dates, phone numbers and
/// numbers of four or more digits. Small numbers ("UBO 2", "section 3.1") stay.
fn mask(s: &str) -> (String, usize) {
    use std::sync::OnceLock;
    static RES: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let res = RES.get_or_init(|| {
        [
            r"[\w.+-]+@[\w-]+(\.[\w-]+)+",
            r"(?i)\b(https?://|www\.)\S+",
            r"(?i)\b[\w-]+(\.[\w-]+)*\.(com|nl|de|be|lu|uk|eu|org|net|ch|fr|ie|it|es|at|us|io|bank)\b(/\S*)?",
            r"(?i)\b[A-Z]{2}\d{2}(\s?[A-Z0-9]){10,30}\b",
            r"\b(\d{1,2}[./-]\d{1,2}[./-](\d{4}|\d{2})|\d{4}-\d{2}-\d{2})\b",
            r"\+?\d[\d\s().-]{6,}\d",
            r"\d{4,}",
        ]
        .iter()
        .map(|p| regex::Regex::new(p).unwrap())
        .collect()
    });
    let mut out = s.to_string();
    let mut n = 0;
    for re in res {
        // A run only counts as a phone or account number with at least 7 digits in it,
        // so "(1) (2) (3)" or "1. 2. 3." in a list stays.
        let mut c = 0;
        out = re
            .replace_all(&out, |m: &regex::Captures| {
                let t = &m[0];
                if t.chars().filter(|x| x.is_ascii_digit()).count() < 7 && t.chars().any(|x| !x.is_ascii_digit()) && t.starts_with(|x: char| x.is_ascii_digit() || x == '+') && !t.contains('@') && !t.contains('/') && !t.contains('-') {
                    return t.to_string();
                }
                c += 1;
                "[…]".to_string()
            })
            .into_owned();
        n += c;
    }
    (out, n)
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > n { t.chars().take(n).collect::<String>() + "…" } else { t }
}

fn tool(mode: &str) -> Value {
    let mut item = json!({
        "type": "object",
        "properties": {
            "id": { "type": "string" },
            "key": { "type": ["string", "null"] },
            "as": { "type": "string" },
            "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
            "note": { "type": "string" }
        },
        "required": ["id", "key", "confidence"]
    });
    if mode == "lines" {
        let p = item["properties"].as_object_mut().unwrap();
        p.insert("place".into(), json!({ "type": "string", "enum": ["right", "below", "mark"], "description": "Where the answer goes relative to the label line: right of it (after a colon or on a blank line segment), on the blank line below it, or 'mark' to tick an option (with 'option')." }));
        p.insert("option".into(), json!({ "type": "string", "description": "For place=mark: the exact option text on the line to tick, e.g. 'Yes'." }));
        p.insert("label".into(), json!({ "type": "string", "description": "For place=right: the exact label text on the line that the answer follows, e.g. 'Date of birth:'. Needed when a line holds more than one label." }));
    }
    json!({
        "name": "submit_matches",
        "description": "Submit one entry per form field (or per label line) that you matched. Unmatched items can be left out.",
        "input_schema": { "type": "object", "properties": { "matches": { "type": "array", "items": item } }, "required": ["matches"] }
    })
}

/// Identifiers are sent unscrubbed, so they must look like identifiers and nothing else:
/// field ids ("f12", "a3", "L2-14"), kinds ("text", "check") and profile keys ("ubo",
/// "{role}.N.full_name", "x_tax_ref_ab12").
fn ident(s: &str, max: usize, extra: &[char]) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

fn validate(req: &MatchRequest) -> Result<(), String> {
    let bad = |what: &str, v: &str| Err(format!("Not sent: {what} {:?} isn't a plain identifier.", clip(v, 40)));
    for k in &req.keys {
        if !ident(&k.key, 80, &['_', '.', '{', '}', '-']) { return bad("key", &k.key); }
        if !ident(&k.kind, 20, &['_']) { return bad("kind", &k.kind); }
    }
    for f in &req.fields {
        if !ident(&f.id, 20, &['-', '_']) { return bad("field id", &f.id); }
        if !ident(&f.kind, 10, &['_']) { return bad("field kind", &f.kind); }
    }
    for l in &req.lines {
        if !ident(&l.id, 20, &['-', '_']) { return bad("line id", &l.id); }
    }
    Ok(())
}

/// Build the user message. Every string from the form goes through the scrubber. Identifiers
/// are validated first; a profile key that contains a profile value (a custom item named after
/// the company, say) is left out of the list rather than sent.
fn build(req: &MatchRequest, s: &Scrubber) -> (String, usize) {
    let mut removed = 0;
    let mut dropped = 0;
    let key_ok = |k: &str| s.scrub(&k.replace(['_', '.'], " ")).1 == 0;
    let mut sc = |t: &str, n: usize| {
        let (o, k) = s.scrub(&clip(t, n));
        let (o, m) = mask(&o);
        removed += k + m;
        o
    };
    let mut out = String::new();
    if !req.title.is_empty() {
        out.push_str(&format!("Form: {}\n\n", sc(&req.title, 160)));
    }
    out.push_str("Profile keys (key | name | type | choices):\n");
    for k in &req.keys {
        if !key_ok(&k.key) {
            dropped += 1;
            continue;
        }
        let ch =if k.choices.is_empty() { String::new() } else { format!(" | {}", k.choices.iter().map(|c| sc(c, 60)).collect::<Vec<_>>().join(" / ")) };
        out.push_str(&format!("{} | {} | {}{}\n", clip(&k.key, 80), sc(&k.label, 120), clip(&k.kind, 20), ch));
    }
    if req.mode == "lines" {
        out.push_str("\nThis form has no fillable fields. These are its text lines in reading order (id | page | text); lines starting with ## look like headings. Match the lines that ask for something; answers will be typed onto the page where you say. A line can hold several labels (\"Name: ____ Date of birth: ____\"): return one entry per label, each with its label. For tick-box questions return one entry per box that could be ticked, e.g. for \"Regulated? [ ] Yes [ ] No\": place=mark option=Yes as=check, and place=mark option=No as=check:!yes.\n");
        for l in &req.lines {
            out.push_str(&format!("{} | p{} | {}\n", clip(&l.id, 20), l.page, sc(&l.text, 300)));
        }
    } else {
        out.push_str("\nForm fields (id | kind | page | internal name | tooltip | printed label nearby | section heading | options):\n");
        for f in &req.fields {
            let opts = f.options.iter().map(|o| sc(o, 60)).collect::<Vec<_>>().join(" / ");
            out.push_str(&format!(
                "{} | {} | p{} | {} | {} | {} | {} | {}\n",
                clip(&f.id, 20), clip(&f.kind, 10), f.page, sc(&f.name, 120), sc(&f.tip, 300), sc(&f.near, 300), sc(&f.section, 120), opts
            ));
        }
    }
    (out, removed + dropped)
}

pub async fn run(req: MatchRequest, profile_json: &str) -> Result<MatchResult, String> {
    if !MODELS.contains(&req.model.as_str()) {
        return Err(format!("Unknown model {}", req.model));
    }
    validate(&req)?;
    let key = api_key().ok_or("NOKEY: No Anthropic API key is set. Add one under Profile → Settings.")?;
    let mut scrubber = Scrubber::from_profile(profile_json);
    scrubber.add_terms(&req.avoid);
    let (msg, removed) = build(&req, &scrubber);
    let body = json!({
        "model": req.model,
        "max_tokens": 16000,
        "system": system_prompt(),
        "tools": [tool(&req.mode)],
        "tool_choice": { "type": "tool", "name": "submit_matches" },
        "messages": [{ "role": "user", "content": msg }]
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the Claude API: {e}"))?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|e| format!("Unreadable reply from the Claude API: {e}"))?;
    if !status.is_success() {
        let detail = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("");
        return Err(match status.as_u16() {
            401 | 403 => format!("The API key was rejected. {detail}"),
            429 => format!("Rate limited by the Claude API. Try again in a minute. {detail}"),
            529 | 503 => "The Claude API is overloaded. Try again shortly.".into(),
            c => format!("Claude API error {c}: {detail}"),
        });
    }
    let input = v["content"]
        .as_array()
        .and_then(|a| a.iter().find(|b| b["type"] == "tool_use"))
        .map(|b| b["input"]["matches"].clone())
        .ok_or("The Claude API didn't return any matches.")?;
    Ok(MatchResult { matches: input, removed, sent_chars: msg.chars().count() })
}

/// What would be sent, for the "show me exactly what goes out" button.
pub fn preview(req: &MatchRequest, profile_json: &str) -> Result<(String, usize), String> {
    validate(req)?;
    let mut s = Scrubber::from_profile(profile_json);
    s.add_terms(&req.avoid);
    let (m, n) = build(req, &s);
    Ok((format!("SYSTEM\n{}\n\nUSER\n{}", system_prompt(), m), n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_identifying_bits() {
        let (o, n) = mask("Send to kyc@bigbank.com or see www.bigbank.nl/privacy, call +31 20 555 1234, IBAN NL91 ABNA 0417 1643 00, ref 2023-0042, dated 14/03/2019");
        for bad in ["kyc@", "bigbank", "555", "0417", "0042", "2019"] { assert!(!o.contains(bad), "{bad} in {o}"); }
        assert!(n >= 6);
        for keep in ["UBO 2: date of birth (dd/mm/yyyy), section 3.1", "Section 2.1.3 Directors", "Tick (1) (2) (3) (4) as applicable", "Form W-8BEN-E, Part 1, line 4"] {
            assert_eq!(mask(keep).0, keep);
        }
    }

    #[test]
    fn cuts_counterparty_name() {
        let req: MatchRequest = serde_json::from_str(r##"{"model":"claude-sonnet-5-5","mode":"lines","keys":[],"avoid":["Bigbank Clearing N.V."],
            "lines":[{"id":"L1","page":1,"text":"BIGBANK CLEARING CLIENT ONBOARDING"},{"id":"L2","page":1,"text":"Legal name:"}]}"##).unwrap();
        let mut s = Scrubber::from_profile("{}"); s.add_terms(&req.avoid);
        let (m, _) = build(&req, &s);
        assert!(!m.to_lowercase().contains("bigbank"), "{m}");
        assert!(m.contains("Legal name:"));
    }

    #[test]
    fn rejects_smuggled_values() {
        let r: Result<MatchRequest, _> = serde_json::from_str(r#"{"model":"claude-sonnet-5-5","mode":"fields","keys":[{"key":"legal_name","label":"Legal name","kind":"text","value":"Secret BV"}]}"#);
        assert!(r.is_err());
    }

    #[test]
    fn identifiers_must_be_identifiers() {
        let ok: MatchRequest = serde_json::from_str(r#"{"model":"claude-sonnet-5-5","mode":"lines","keys":[{"key":"{role}.N.full_name","label":"Full name","kind":"text"},{"key":"x_tax_ref_ab12","label":"Tax ref","kind":"text"}],"lines":[{"id":"L2-14","page":1,"text":"Name:"}]}"#).unwrap();
        assert!(validate(&ok).is_ok());
        for bad in [
            r#"{"model":"claude-sonnet-5-5","mode":"fields","keys":[{"key":"legal_name Northwind Holding BV","label":"x","kind":"text"}]}"#,
            r#"{"model":"claude-sonnet-5-5","mode":"fields","keys":[{"key":"k","label":"x","kind":"Jan de Vries"}]}"#,
            r#"{"model":"claude-sonnet-5-5","mode":"fields","keys":[],"fields":[{"id":"NL91ABNA 04171643","kind":"text"}]}"#,
            r#"{"model":"claude-sonnet-5-5","mode":"lines","keys":[],"lines":[{"id":"a b","page":1,"text":"x"}]}"#,
        ] {
            let r: MatchRequest = serde_json::from_str(bad).unwrap();
            assert!(validate(&r).is_err(), "{bad}");
        }
    }

    #[test]
    fn drops_keys_named_after_profile_values() {
        let req: MatchRequest = serde_json::from_str(r#"{"model":"claude-sonnet-5-5","mode":"fields","keys":[{"key":"legal_name","label":"Legal name","kind":"text"},{"key":"x_northwind_ref_ab12","label":"Reference","kind":"text"}]}"#).unwrap();
        let (m, n) = build(&req, &Scrubber::from_profile(r#"{"entities":[{"name":"Northwind Holding B.V.","values":{}}]}"#));
        assert!(!m.to_lowercase().contains("northwind"), "{m}");
        assert!(m.contains("legal_name") && n >= 1);
    }

    #[test]
    fn scrubs_form_text() {
        let req: MatchRequest = serde_json::from_str(r#"{"model":"claude-sonnet-5-5","mode":"fields","keys":[{"key":"legal_name","label":"Legal name","kind":"text"}],
            "fields":[{"id":"f1","kind":"text","name":"Text1","near":"Company name (prefilled: Northwind Holding BV)"}]}"#).unwrap();
        let (m, n) = build(&req, &Scrubber::from_profile(r#"{"entities":[{"name":"Northwind Holding B.V.","values":{}}]}"#));
        assert!(!m.contains("Northwind"), "{m}");
        assert!(n >= 1);
    }
}

#[cfg(test)]
mod show {
    #[test]
    #[ignore]
    fn print_prompt() {
        let req: super::MatchRequest = serde_json::from_str(r#"{"model":"claude-sonnet-5-5","mode":"fields","title":"cdd.pdf","keys":[{"key":"legal_name","label":"Legal name","kind":"text"},{"key":"ubo","label":"UBOs","kind":"role"},{"key":"{role}.N.full_name","label":"Full name","kind":"text"}],
            "fields":[{"id":"f1","kind":"text","page":1,"name":"Text 1","near":"left: Full legal name of the entity","section":"1. ENTITY DETAILS"}]}"#).unwrap();
        println!("{}", super::preview(&req, r#"{"entities":[]}"#).unwrap().0);
    }
}
