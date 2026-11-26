/**
 * The settings an admin can give everyone a default for (cooktrace#93),
 * with the values CookTrace offers for each and the environment variable
 * that sets and locks it. The app's own pickers read these lists too
 * (Settings > Regional & Units, Food Sources), so the two can't drift.
 * Kept in server/lib because the server image has no src/.
 */
export const REGIONAL_OPTIONS = {
  language:          { env: 'DEFAULT_LANGUAGE',            values: ['en', 'es', 'fr', 'sv'] },
  measurementSystem: { env: 'DEFAULT_MEASUREMENT_SYSTEM',  values: ['metric', 'imperial'] },
  energyUnit:        { env: 'DEFAULT_ENERGY_UNIT',         values: ['kcal', 'kJ'] },
  dateFormat:        { env: 'DEFAULT_DATE_FORMAT',         values: ['ISO', 'US', 'EU', 'natural'] },
  timeFormat:        { env: 'DEFAULT_TIME_FORMAT',         values: ['12h', '24h'] },
  offSearchLanguage: { env: 'DEFAULT_OFF_SEARCH_LANGUAGE', values: ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ja', 'zh', 'ar', 'ko'] },
  offSearchCountry:  {
    env: 'DEFAULT_OFF_SEARCH_COUNTRY',
    values: ['World',
      'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Canada', 'Chile', 'China',
      'Denmark', 'Finland', 'France', 'Germany', 'India', 'Ireland', 'Italy', 'Japan',
      'Mexico', 'Netherlands', 'New Zealand', 'Norway', 'Poland', 'Portugal', 'Singapore',
      'South Africa', 'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Ukraine',
      'United Kingdom', 'United States'],
  },
};
