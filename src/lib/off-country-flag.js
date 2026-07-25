/**
 * Convert an Open Food Facts country tag (e.g. "en:france", "france",
 * "fr") to a flag emoji ("🇫🇷") for display in food search results.
 *
 * OFF's country slugs come from their taxonomy — mostly the English
 * name lowercased and dash-separated, sometimes with an "en:" language
 * prefix. This module normalises them, maps to ISO 3166-1 alpha-2
 * codes, and builds the flag emoji from the two regional-indicator
 * codepoints (0x1F1E6 = 'A').
 *
 * Coverage: the ~80 countries below cover the vast majority of OFF's
 * populated products (top food producers + consumer markets on all
 * continents). Anything outside the list returns an empty string so
 * the caller can gracefully render nothing.
 *
 * Data source for origin flags on results: OFF's `origins_tags` field
 * (preferred — the actual manufacturing country) with fallback to
 * `manufacturing_places_tags`. `countries_tags` is intentionally NOT
 * used as a fallback because it means "where sold", not "where from",
 * and flagging a US supermarket with a French flag because the product
 * is French but sold in the US would be misleading.
 */

// Country slug (from OFF tags) → ISO 3166-1 alpha-2 code
// Coverage: all UN member states + notable dependent territories that OFF
// actually tags. Only a data table, no logic — safe to extend.
const OFF_SLUG_TO_ISO = {
  // Americas
  'united-states': 'US', 'usa': 'US', 'us': 'US',
  'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR',
  'chile': 'CL', 'colombia': 'CO', 'peru': 'PE', 'venezuela': 'VE',
  'ecuador': 'EC', 'uruguay': 'UY', 'paraguay': 'PY', 'bolivia': 'BO',
  'costa-rica': 'CR', 'panama': 'PA', 'guatemala': 'GT', 'honduras': 'HN',
  'el-salvador': 'SV', 'nicaragua': 'NI', 'cuba': 'CU',
  'dominican-republic': 'DO', 'jamaica': 'JM', 'puerto-rico': 'PR',
  'haiti': 'HT', 'bahamas': 'BS', 'barbados': 'BB', 'belize': 'BZ',
  'dominica': 'DM', 'grenada': 'GD', 'guyana': 'GY', 'suriname': 'SR',
  'trinidad-and-tobago': 'TT', 'antigua-and-barbuda': 'AG',
  'saint-lucia': 'LC', 'saint-kitts-and-nevis': 'KN',
  'saint-vincent-and-the-grenadines': 'VC',
  'bermuda': 'BM', 'cayman-islands': 'KY', 'greenland': 'GL',
  'guadeloupe': 'GP', 'martinique': 'MQ', 'french-guiana': 'GF',
  'aruba': 'AW', 'curacao': 'CW',

  // Europe
  'united-kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'scotland': 'GB',
  'wales': 'GB', 'northern-ireland': 'GB',
  'france': 'FR', 'germany': 'DE', 'spain': 'ES', 'italy': 'IT',
  'netherlands': 'NL', 'belgium': 'BE', 'switzerland': 'CH',
  'austria': 'AT', 'portugal': 'PT', 'ireland': 'IE', 'iceland': 'IS',
  'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
  'poland': 'PL', 'russia': 'RU', 'ukraine': 'UA', 'greece': 'GR',
  'romania': 'RO', 'czech-republic': 'CZ', 'czechia': 'CZ',
  'hungary': 'HU', 'slovakia': 'SK', 'slovenia': 'SI', 'croatia': 'HR',
  'bulgaria': 'BG', 'serbia': 'RS', 'bosnia-and-herzegovina': 'BA',
  'moldova': 'MD', 'macedonia': 'MK', 'north-macedonia': 'MK',
  'albania': 'AL', 'estonia': 'EE', 'latvia': 'LV', 'lithuania': 'LT',
  'luxembourg': 'LU', 'malta': 'MT', 'cyprus': 'CY',
  'belarus': 'BY', 'kosovo': 'XK', 'montenegro': 'ME',
  'andorra': 'AD', 'monaco': 'MC', 'liechtenstein': 'LI',
  'san-marino': 'SM', 'vatican-city': 'VA', 'faroe-islands': 'FO',
  'gibraltar': 'GI',

  // Asia
  'japan': 'JP', 'china': 'CN', 'india': 'IN', 'south-korea': 'KR',
  'korea': 'KR', 'north-korea': 'KP', 'taiwan': 'TW', 'hong-kong': 'HK',
  'macao': 'MO', 'mongolia': 'MN', 'thailand': 'TH', 'vietnam': 'VN',
  'philippines': 'PH', 'indonesia': 'ID', 'malaysia': 'MY',
  'singapore': 'SG', 'nepal': 'NP', 'bangladesh': 'BD',
  'sri-lanka': 'LK', 'pakistan': 'PK', 'afghanistan': 'AF',
  'myanmar': 'MM', 'cambodia': 'KH', 'laos': 'LA', 'brunei': 'BN',
  'bhutan': 'BT', 'maldives': 'MV', 'east-timor': 'TL',
  'kyrgyzstan': 'KG', 'tajikistan': 'TJ', 'turkmenistan': 'TM',
  'uzbekistan': 'UZ',

  // Middle East + North Africa
  'israel': 'IL', 'palestine': 'PS', 'saudi-arabia': 'SA',
  'united-arab-emirates': 'AE', 'uae': 'AE', 'iran': 'IR', 'iraq': 'IQ',
  'syria': 'SY', 'lebanon': 'LB', 'jordan': 'JO', 'kuwait': 'KW',
  'qatar': 'QA', 'oman': 'OM', 'bahrain': 'BH', 'yemen': 'YE',
  'turkey': 'TR', 'georgia': 'GE', 'armenia': 'AM', 'azerbaijan': 'AZ',
  'kazakhstan': 'KZ', 'egypt': 'EG', 'morocco': 'MA', 'algeria': 'DZ',
  'tunisia': 'TN', 'libya': 'LY', 'western-sahara': 'EH',

  // Sub-Saharan Africa
  'south-africa': 'ZA', 'kenya': 'KE', 'ethiopia': 'ET',
  'tanzania': 'TZ', 'uganda': 'UG', 'nigeria': 'NG', 'ghana': 'GH',
  'senegal': 'SN', 'ivory-coast': 'CI', 'cote-d-ivoire': 'CI',
  'cameroon': 'CM', 'zimbabwe': 'ZW', 'zambia': 'ZM', 'botswana': 'BW',
  'namibia': 'NA', 'mozambique': 'MZ', 'madagascar': 'MG',
  'mauritius': 'MU', 'reunion': 'RE', 'seychelles': 'SC',
  'angola': 'AO', 'benin': 'BJ', 'burkina-faso': 'BF', 'burundi': 'BI',
  'cape-verde': 'CV', 'central-african-republic': 'CF', 'chad': 'TD',
  'comoros': 'KM', 'congo': 'CG',
  'democratic-republic-of-the-congo': 'CD', 'dr-congo': 'CD',
  'djibouti': 'DJ', 'equatorial-guinea': 'GQ', 'eritrea': 'ER',
  'eswatini': 'SZ', 'swaziland': 'SZ', 'gabon': 'GA', 'gambia': 'GM',
  'guinea': 'GN', 'guinea-bissau': 'GW', 'lesotho': 'LS',
  'liberia': 'LR', 'malawi': 'MW', 'mali': 'ML', 'mauritania': 'MR',
  'niger': 'NE', 'rwanda': 'RW', 'sao-tome-and-principe': 'ST',
  'sierra-leone': 'SL', 'somalia': 'SO', 'south-sudan': 'SS',
  'sudan': 'SD', 'togo': 'TG',

  // Oceania
  'australia': 'AU', 'new-zealand': 'NZ', 'fiji': 'FJ',
  'papua-new-guinea': 'PG', 'french-polynesia': 'PF',
  'new-caledonia': 'NC', 'samoa': 'WS', 'solomon-islands': 'SB',
  'tonga': 'TO', 'vanuatu': 'VU', 'kiribati': 'KI',
  'marshall-islands': 'MH', 'micronesia': 'FM', 'nauru': 'NR',
  'palau': 'PW', 'tuvalu': 'TV',
};

/**
 * Convert an OFF country tag to a flag emoji. Handles either the raw
 * slug ("france") or the language-prefixed form ("en:france"). Returns
 * '' when the country isn't in the mapping — caller should render
 * nothing in that case rather than a placeholder.
 */
export function offCountryTagToFlag(tag) {
  if (!tag) return '';
  const slug = String(tag).replace(/^\w+:/, '').toLowerCase().trim();
  const iso = OFF_SLUG_TO_ISO[slug];
  if (!iso || iso.length !== 2) return '';
  const base = 0x1F1E6;
  const a = base + iso.charCodeAt(0) - 65;
  const b = base + iso.charCodeAt(1) - 65;
  return String.fromCodePoint(a) + String.fromCodePoint(b);
}

/**
 * Convert an OFF country tag to its display name in English. Useful for
 * the flag emoji's tooltip so users on platforms where flag emojis
 * render as country codes still get the country name on hover.
 */
export function offCountryTagToName(tag) {
  if (!tag) return '';
  const slug = String(tag).replace(/^\w+:/, '').toLowerCase().trim();
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
