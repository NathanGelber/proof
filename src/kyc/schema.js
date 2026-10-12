// What a profile can hold. Company items, the items kept for each person, the roles a person
// can have, and the kinds of document. `aliases` are the phrases forms use for an item; the
// local matcher looks for them in field labels (English and Dutch, a little German and French).

export const YESNO = ['yes', 'no'];

export const FATCA = ['Participating FFI', 'Reporting Model 1 FFI', 'Reporting Model 2 FFI', 'Registered deemed-compliant FFI', 'Certified deemed-compliant FFI', 'Exempt beneficial owner', 'Active NFFE', 'Passive NFFE', 'Excepted NFFE', 'Direct reporting NFFE', 'Sponsored direct reporting NFFE'];
export const CRS = ['Financial Institution: Investment Entity', 'Financial Institution: Depository Institution', 'Financial Institution: Custodial Institution', 'Financial Institution: Specified Insurance Company', 'Active NFE: listed or related to a listed entity', 'Active NFE: governmental entity, international organisation or central bank', 'Active NFE: other', 'Passive NFE'];

const k = (key, label, kind, aliases = [], extra = {}) => ({ key, label, kind, aliases, ...extra });

export const GROUPS = [
  ['identity', 'Company'], ['address', 'Addresses'], ['tax', 'Tax, FATCA and CRS'], ['regulation', 'Regulation and listing'],
  ['business', 'Business'], ['bank', 'Banking'], ['declarations', 'Declarations'], ['contact', 'Contact'],
];

export const ENTITY_KEYS = [
  k('legal_name', 'Legal name', 'text', ['legal name', 'company name', 'entity name', 'name of entity', 'name of the entity', 'registered name', 'full legal name', 'name of the company', 'name of legal entity', 'name of the legal entity', 'organisation name', 'organization name', 'name of organisation', 'name of organization', 'name of institution', 'statutaire naam', 'naam rechtspersoon', 'naam onderneming', 'bedrijfsnaam', 'firmenname', 'raison sociale', 'denomination sociale'], { group: 'identity' }),
  k('trade_name', 'Trade name', 'text', ['trade name', 'trading name', 'doing business as', 'dba', 'handelsnaam', 'business name'], { group: 'identity' }),
  k('legal_form', 'Legal form', 'text', ['legal form', 'legal status', 'type of entity', 'entity type', 'type of legal entity', 'rechtsvorm', 'company type', 'form of organisation', 'form of organization', 'legal structure', 'rechtsform', 'forme juridique'], { group: 'identity' }),
  k('reg_number', 'Registration number', 'text', ['registration number', 'company number', 'company registration number', 'chamber of commerce number', 'chamber of commerce', 'kvk', 'kvk nummer', 'kvk number', 'commercial register number', 'trade register number', 'registry number', 'incorporation number', 'register number', 'handelsregisternummer', 'coc number'], { group: 'identity' }),
  k('reg_authority', 'Registered with', 'text', ['registration authority', 'registry', 'name of register', 'place of registration', 'commercial register', 'trade register'], { group: 'identity' }),
  k('inc_country', 'Country of incorporation', 'country', ['country of incorporation', 'country of registration', 'jurisdiction of incorporation', 'country of establishment', 'jurisdiction', 'place of incorporation', 'land van vestiging', 'country of formation', 'domicile'], { group: 'identity' }),
  k('inc_date', 'Date of incorporation', 'date', ['date of incorporation', 'incorporation date', 'date of establishment', 'date of registration', 'date of formation', 'oprichtingsdatum', 'datum oprichting', 'date established', 'founded'], { group: 'identity' }),
  k('lei', 'LEI', 'text', ['lei', 'legal entity identifier', 'lei code', 'lei number'], { group: 'identity' }),
  k('website', 'Website', 'text', ['website', 'web site', 'url', 'internet address'], { group: 'identity' }),
  k('email', 'General email', 'email', ['email', 'e-mail', 'email address', 'e-mail address'], { group: 'identity' }),
  k('phone', 'General phone', 'phone', ['phone', 'telephone', 'phone number', 'telephone number', 'tel', 'telefoon'], { group: 'identity' }),

  k('reg_street', 'Registered address: street and number', 'text', ['registered address street', 'street', 'street and number', 'address line 1', 'straat', 'straat en huisnummer'], { group: 'address' }),
  k('reg_postcode', 'Registered address: postcode', 'text', ['postcode', 'postal code', 'zip', 'zip code', 'post code'], { group: 'address' }),
  k('reg_city', 'Registered address: city', 'text', ['city', 'town', 'place', 'plaats', 'woonplaats', 'vestigingsplaats', 'stadt', 'ville'], { group: 'address' }),
  k('reg_country', 'Registered address: country', 'country', ['country', 'land'], { group: 'address' }),
  k('reg_address', 'Registered address (one line)', 'computed', ['registered address', 'registered office', 'registered office address', 'statutory address', 'statutair adres', 'statutaire zetel', 'registered seat', 'address of registered office', 'address'], { group: 'address', from: ['reg_street', 'reg_postcode', 'reg_city', 'reg_country'] }),
  k('op_street', 'Business address: street and number', 'text', ['business address street', 'principal place of business street'], { group: 'address' }),
  k('op_postcode', 'Business address: postcode', 'text', [], { group: 'address' }),
  k('op_city', 'Business address: city', 'text', [], { group: 'address' }),
  k('op_country', 'Business address: country', 'country', [], { group: 'address' }),
  k('op_address', 'Business address (one line)', 'computed', ['business address', 'operating address', 'operational address', 'principal place of business', 'trading address', 'correspondence address', 'mailing address', 'postal address', 'visiting address', 'bezoekadres', 'postadres', 'principal business address', 'head office address'], { group: 'address', from: ['op_street', 'op_postcode', 'op_city', 'op_country'] }),

  k('tax_country', 'Tax residence', 'country', ['tax residence', 'country of tax residence', 'tax residency', 'resident for tax purposes', 'fiscal residence', 'country of residence for tax purposes', 'jurisdiction of tax residence'], { group: 'tax' }),
  k('tin', 'Tax identification number (TIN)', 'text', ['tin', 'tax identification number', 'tax id', 'tax number', 'fiscal number', 'taxpayer identification number', 'fiscaal nummer', 'tax reference'], { group: 'tax' }),
  k('rsin', 'RSIN', 'text', ['rsin'], { group: 'tax' }),
  k('vat', 'VAT number', 'text', ['vat', 'vat number', 'vat id', 'vat registration number', 'btw', 'btw nummer', 'btw-id', 'ust-id'], { group: 'tax' }),
  k('fatca_status', 'FATCA classification', 'choice', ['fatca', 'fatca status', 'fatca classification', 'chapter 4 status'], { group: 'tax', choices: FATCA }),
  k('giin', 'GIIN', 'text', ['giin', 'global intermediary identification number'], { group: 'tax' }),
  k('crs_status', 'CRS classification', 'choice', ['crs', 'crs status', 'crs classification', 'entity type under crs'], { group: 'tax', choices: CRS }),
  k('us_person', 'Is a US person', 'bool', ['us person', 'u.s. person', 'specified us person', 'us entity'], { group: 'tax' }),

  k('regulated', 'Is regulated', 'bool', ['regulated', 'regulated entity', 'supervised', 'licensed', 'authorised', 'authorized', 'regulated financial institution'], { group: 'regulation' }),
  k('regulator', 'Regulator', 'text', ['regulator', 'name of regulator', 'regulatory authority', 'supervisory authority', 'supervisor', 'toezichthouder', 'competent authority'], { group: 'regulation' }),
  k('licence_number', 'Licence or regulator reference', 'text', ['licence number', 'license number', 'regulatory number', 'regulator reference', 'registration number with regulator', 'permit number', 'vergunningnummer', 'frn'], { group: 'regulation' }),
  k('listed', 'Is listed', 'bool', ['listed', 'publicly listed', 'publicly traded', 'listed on a stock exchange', 'quoted', 'beursgenoteerd'], { group: 'regulation' }),
  k('exchange', 'Stock exchange', 'text', ['stock exchange', 'exchange of listing', 'name of exchange', 'listing venue', 'regulated market'], { group: 'regulation' }),
  k('exchange_memberships', 'Exchange and clearing memberships', 'longtext', ['exchange memberships', 'trading venues', 'clearing memberships', 'member of exchanges'], { group: 'regulation' }),

  k('nature_of_business', 'Nature of business', 'longtext', ['nature of business', 'nature of the business', 'business activities', 'business activity', 'principal activity', 'principal activities', 'main activity', 'main activities', 'description of business', 'description of the business', 'purpose of the company', 'objects', 'activities', 'aard van de onderneming', 'bedrijfsactiviteiten', 'activiteiten', 'type of business', 'core business'], { group: 'business' }),
  k('industry', 'Industry or sector', 'text', ['industry', 'sector', 'industry sector', 'business sector', 'branche'], { group: 'business' }),
  k('industry_code', 'Industry code (SBI/NACE/SIC)', 'text', ['sbi', 'sbi code', 'nace', 'nace code', 'sic', 'sic code', 'naics', 'industry code'], { group: 'business' }),
  k('countries_of_operation', 'Countries of operation', 'text', ['countries of operation', 'countries where business is conducted', 'geographical area', 'countries of activity', 'jurisdictions of operation'], { group: 'business' }),
  k('employees', 'Number of employees', 'number', ['number of employees', 'employees', 'staff', 'headcount', 'fte', 'aantal werknemers'], { group: 'business' }),
  k('turnover', 'Annual turnover', 'text', ['annual turnover', 'turnover', 'revenue', 'annual revenue', 'omzet', 'gross revenue'], { group: 'business' }),
  k('total_assets', 'Total assets', 'text', ['total assets', 'balance sheet total', 'balanstotaal'], { group: 'business' }),
  k('equity', 'Equity', 'text', ['equity', 'net assets', 'shareholders equity', 'eigen vermogen', 'capital'], { group: 'business' }),
  k('source_of_funds', 'Source of funds', 'longtext', ['source of funds', 'origin of funds', 'herkomst van de middelen', 'herkomst gelden', 'source of the funds'], { group: 'business' }),
  k('source_of_wealth', 'Source of wealth', 'longtext', ['source of wealth', 'origin of wealth', 'herkomst vermogen'], { group: 'business' }),
  k('purpose', 'Purpose of the relationship', 'longtext', ['purpose of the business relationship', 'purpose of the relationship', 'purpose of the account', 'reason for opening', 'intended nature of the business relationship', 'doel van de relatie', 'purpose and intended nature'], { group: 'business' }),
  k('expected_activity', 'Expected activity', 'longtext', ['expected activity', 'expected volume', 'anticipated activity', 'expected transactions', 'anticipated volume', 'expected turnover', 'expected number of transactions'], { group: 'business' }),

  k('bank_name', 'Bank name', 'text', ['bank name', 'name of bank', 'bank'], { group: 'bank' }),
  k('iban', 'IBAN', 'text', ['iban', 'account number', 'bank account number', 'rekeningnummer', 'bank account'], { group: 'bank' }),
  k('bic', 'BIC / SWIFT', 'text', ['bic', 'swift', 'swift code', 'bic code', 'swift bic'], { group: 'bank' }),
  k('account_holder', 'Account holder', 'text', ['account holder', 'account name', 'name of account holder', 'beneficiary name', 'tenaamstelling'], { group: 'bank' }),

  k('sanctions_exposure', 'Any sanctions exposure', 'bool', ['sanctions', 'sanctioned', 'sanctioned countries', 'sanctioned persons', 'subject to sanctions', 'ofac'], { group: 'declarations' }),
  k('pep_any', 'Any PEP among directors, owners or signatories', 'bool', ['politically exposed', 'pep', 'peps', 'politically exposed person'], { group: 'declarations' }),
  k('aml_policy', 'Has an AML/CFT policy', 'bool', ['aml policy', 'anti-money laundering policy', 'aml program', 'aml programme', 'aml/cft policy', 'kyc policy'], { group: 'declarations' }),
  k('bearer_shares', 'Has issued bearer shares', 'bool', ['bearer shares', 'bearer share', 'toonderaandelen'], { group: 'declarations' }),
  k('shell_bank', 'Is a shell bank', 'bool', ['shell bank'], { group: 'declarations' }),
  k('nominee', 'Uses nominee shareholders or directors', 'bool', ['nominee', 'nominee shareholder', 'nominee director', 'nominees'], { group: 'declarations' }),

  k('contact_name', 'Contact person', 'text', ['contact person', 'contact name', 'name of contact', 'contactpersoon', 'primary contact'], { group: 'contact' }),
  k('contact_title', 'Contact person: position', 'text', ['contact title', 'contact position', 'contact function'], { group: 'contact' }),
  k('contact_email', 'Contact person: email', 'email', ['contact email', 'contact e-mail', 'email of contact'], { group: 'contact' }),
  k('contact_phone', 'Contact person: phone', 'phone', ['contact phone', 'contact telephone', 'phone of contact'], { group: 'contact' }),
];

export const ROLES = [
  { role: 'director', label: 'Director', plural: 'Directors', aliases: ['director', 'directors', 'board member', 'board of directors', 'managing director', 'bestuurder', 'bestuurders', 'bestuur', 'officer', 'officers', 'management board', 'executive', 'geschäftsführer', 'dirigeant'] },
  { role: 'ubo', label: 'UBO', plural: 'UBOs', aliases: ['ubo', 'ubos', 'beneficial owner', 'beneficial owners', 'ultimate beneficial owner', 'ultimate beneficial owners', 'controlling person', 'controlling persons', 'uiteindelijk belanghebbende', 'uiteindelijk belanghebbenden', 'person with significant control', 'wirtschaftlich berechtigter', 'bénéficiaire effectif'] },
  { role: 'signatory', label: 'Authorised signatory', plural: 'Authorised signatories', aliases: ['signatory', 'signatories', 'authorised signatory', 'authorized signatory', 'authorised signatories', 'authorized signatories', 'authorised person', 'authorized person', 'authorised representative', 'authorized representative', 'tekenbevoegd', 'tekenbevoegde', 'gevolmachtigde', 'signed by', 'signer'] },
  { role: 'member', label: 'Member', plural: 'Members', aliases: ['member', 'members', 'lid', 'leden', 'ledenregister'] },
  { role: 'shareholder', label: 'Shareholder', plural: 'Shareholders', aliases: ['shareholder', 'shareholders', 'aandeelhouder', 'aandeelhouders', 'stockholder', 'owner', 'owners', 'parent company', 'parent'] },
];
export const roleInfo = r => ROLES.find(x => x.role === r);

export const PERSON_KEYS = [
  k('full_name', 'Full name', 'computed', ['full name', 'name', 'naam', 'volledige naam', 'name and surname', 'surname and first names', 'name of person', 'legal name'], { from: ['first_name', 'last_name'] }),
  k('first_name', 'First names', 'text', ['first name', 'first names', 'given name', 'given names', 'forename', 'forenames', 'voornaam', 'voornamen', 'vorname', 'prénom']),
  k('last_name', 'Surname', 'text', ['last name', 'surname', 'family name', 'achternaam', 'geslachtsnaam', 'nachname', 'nom de famille']),
  k('position', 'Position', 'text', ['position', 'title', 'function', 'job title', 'functie', 'capacity', 'role']),
  k('date_of_birth', 'Date of birth', 'date', ['date of birth', 'birth date', 'dob', 'd.o.b', 'geboortedatum', 'geburtsdatum', 'date de naissance']),
  k('place_of_birth', 'Place of birth', 'text', ['place of birth', 'city of birth', 'town of birth', 'geboorteplaats']),
  k('country_of_birth', 'Country of birth', 'country', ['country of birth', 'geboorteland']),
  k('nationality', 'Nationality', 'country', ['nationality', 'citizenship', 'nationaliteit', 'staatsangehörigkeit']),
  k('res_street', 'Address: street and number', 'text', []),
  k('res_postcode', 'Address: postcode', 'text', []),
  k('res_city', 'Address: city', 'text', []),
  k('res_country', 'Address: country', 'country', ['country of residence', 'residence country', 'woonland', 'country']),
  k('res_address', 'Address (one line)', 'computed', ['residential address', 'home address', 'private address', 'permanent address', 'woonadres', 'address', 'adres', 'residence'], { from: ['res_street', 'res_postcode', 'res_city', 'res_country'] }),
  k('ownership_pct', 'Ownership or interest (%)', 'number', ['ownership', 'percentage', 'ownership percentage', '% held', 'percentage held', 'shareholding', 'interest', '% of shares', 'percentage of shares', 'stake', 'belang', 'percentage belang', 'voting rights']),
  k('control', 'Nature of control', 'text', ['nature of control', 'type of control', 'how control is exercised', 'nature of interest', 'aard belang', 'aard van het belang']),
  k('pep', 'Is a PEP', 'bool', ['pep', 'politically exposed', 'politically exposed person']),
  k('pep_details', 'PEP details', 'longtext', ['pep details', 'details of political exposure', 'public function']),
  k('id_type', 'ID document type', 'choice', ['type of id', 'id type', 'type of identification', 'identification document', 'document type', 'type of document'], { choices: ['Passport', 'National ID card', 'Driving licence', 'Residence permit'] }),
  k('id_number', 'ID document number', 'text', ['passport number', 'id number', 'document number', 'identification number', 'id card number', 'passport no', 'documentnummer']),
  k('id_country', 'ID issuing country', 'country', ['issuing country', 'country of issue', 'issued by', 'land van afgifte']),
  k('id_issued', 'ID issue date', 'date', ['date of issue', 'issue date', 'issued on', 'datum afgifte']),
  k('id_expiry', 'ID expiry date', 'date', ['expiry date', 'expiration date', 'date of expiry', 'valid until', 'expires', 'geldig tot']),
  k('tax_country', 'Tax residence', 'country', ['tax residence', 'country of tax residence', 'tax residency']),
  k('tin', 'Tax identification number', 'text', ['tin', 'tax identification number', 'tax id', 'bsn', 'social security number', 'ssn']),
  k('email', 'Email', 'email', ['email', 'e-mail', 'email address']),
  k('phone', 'Phone', 'phone', ['phone', 'telephone', 'mobile', 'phone number']),
  k('reg_number', 'Registration number (if a company)', 'text', ['registration number', 'company number', 'kvk']),
  k('inc_country', 'Country of incorporation (if a company)', 'country', ['country of incorporation', 'jurisdiction of incorporation']),
];

export const SPECIAL_KEYS = [
  k('today', 'Today’s date', 'date', ['date', 'datum', 'date signed', 'signing date', 'dated', 'place and date', 'date of signature']),
];

export const DOC_TYPES = [
  ['kvk_extract', 'Trade register extract (KvK uittreksel)', 90],
  ['articles', 'Articles of association (statuten)', 0],
  ['deed', 'Deed of incorporation', 0],
  ['ubo_extract', 'UBO register extract', 90],
  ['members_register', 'Members register (ledenregister)', 0],
  ['shareholder_register', 'Shareholder register', 0],
  ['org_chart', 'Ownership / organisation chart', 0],
  ['board_resolution', 'Board resolution or power of attorney', 0],
  ['signatory_list', 'Authorised signatory list', 0],
  ['annual_report', 'Annual report / financial statements', 0],
  ['licence', 'Licence or regulatory confirmation', 0],
  ['aml_policy', 'AML/CFT policy', 0],
  ['w8', 'W-8BEN-E or other tax form', 0],
  ['wolfsberg', 'Wolfsberg CBDDQ', 0],
  ['id', 'Identity document', 0],
  ['address_proof', 'Proof of address', 90],
  ['other', 'Other', 0],
];
export const docTypeInfo = t => DOC_TYPES.find(d => d[0] === t) || DOC_TYPES[DOC_TYPES.length - 1];

export const ENUM_KINDS = new Set(['country', 'bool', 'choice']);

/** All keys an entity can be asked for, including custom ones. */
export function entityKeys(ent) { return [...ENTITY_KEYS, ...(ent?.custom || []).filter(c => !c.person).map(c => ({ ...c, group: 'custom', aliases: c.aliases || [c.label] }))]; }
export function personKeys(ent) { return [...PERSON_KEYS, ...(ent?.custom || []).filter(c => c.person).map(c => ({ ...c, aliases: c.aliases || [c.label] }))]; }

/** Look up the definition behind a key like "legal_name", "ubo.2.date_of_birth" or "today". */
export function keyDef(ent, key) {
  if (!key) return null;
  const s = SPECIAL_KEYS.find(x => x.key === key); if (s) return { ...s, scope: 'special' };
  const m = /^([a-z_]+)\.(\d+)\.([a-z0-9_]+)$/.exec(key);
  if (m) { const r = roleInfo(m[1]); const d = personKeys(ent).find(x => x.key === m[3]); return r && d ? { ...d, scope: 'person', role: m[1], n: +m[2] } : null; }
  const d = entityKeys(ent).find(x => x.key === key); return d ? { ...d, scope: 'entity' } : null;
}
export function keyLabel(ent, key) {
  const d = keyDef(ent, key); if (!d) return key || '';
  if (d.scope === 'person') return `${roleInfo(d.role).label} ${d.n} · ${d.label}`;
  return d.label;
}

export function newProfile() {
  return { schema: 1, entities: [], mappings: {}, log: [], settings: { dateFormat: 'DD-MM-YYYY', model: 'claude-sonnet-5-5', useClaude: true } };
}
export function newEntity(name) {
  return { id: crypto.randomUUID(), name, values: { legal_name: { v: name, at: new Date().toISOString().slice(0, 10), hist: [] } }, custom: [], people: [], docs: [] };
}
