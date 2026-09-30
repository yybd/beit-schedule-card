// The synthetic house with English names, for the preview in English (?lang=en) and its screenshots.
// Only display names change. The Beit marker and the mode labels (שבת / חג) are part of the data contract
// and stay in Hebrew.

const NAMES = {
  'מאוורר סלון בשבת': 'Living room fan on Shabbat',
  'תאורת מרפסת בערב': 'Balcony light in the evening',
  'מזגן חדר שינה שבת': 'Bedroom AC Shabbat',
  'מזגן סלון תצוגה': 'Living room AC display',
  'מזגן סלון שבת': 'Living room AC Shabbat',
  'מזגן ילדים חג': 'Kids AC chag',
  'טמפרטורה סלון': 'Living room temperature',
  'תריס חדר שינה': 'Bedroom shutter',
  'מזגן חדר שינה': 'Bedroom AC',
  'מוזיקה בבוקר': 'Morning music',
  'משאבת בריכה': 'Pool pump',
  'פס לד מטבח': 'Kitchen LED strip',
  'רמקול מטבח': 'Kitchen speaker',
  'תאורת מרפסת': 'Balcony light',
  'תאורת סלון': 'Living room light',
  'מנורת לילה': 'Night light',
  'פרשת השבוע': 'Weekly parasha',
  'האם יום טוב': 'Is yom tov',
  'מזגן ילדים': 'Kids AC',
  'מזגן סלון': 'Living room AC',
  'תאריך עברי': 'Hebrew date',
  'חדר ילדים': "Kids' room",
  'חדר שירות': 'Utility room',
  'חדר שינה': 'Bedroom',
  'דוד חשמל': 'Electric boiler',
  'דוד מים': 'Water heater',
  'האם שבת': 'Is Shabbat',
  'אין מידע': 'No data',
  'מרפסת': 'Balcony',
  'מטבח': 'Kitchen',
  'סלון': 'Living room',
  'פלטה': 'Hot plate',
  // Calendar values, as the integrations report them in English.
  'יום ראשון, ט״ו בטבת תשפ״ו': 'Sunday, 15 Tevet 5786',
  'ט״ו טבת תשפ״ו': '15 Tevet 5786',
  'שמות': 'Shemot',
};

// Longest first, so "מזגן סלון שבת" is not turned into "Living room AC שבת".
const PAIRS = Object.entries(NAMES).sort((a, b) => b[0].length - a[0].length);

export function englishHouse(fixtures) {
  let text = JSON.stringify(fixtures);
  for (const [he, en] of PAIRS) text = text.split(he).join(en);
  return JSON.parse(text);
}
