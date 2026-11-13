/**
 * Notes saved as plain text (an import from Paprika, Mealie or a recipe
 * page, an AI agent, the API) keep their line breaks when shown as rich
 * text: with no tag in them, each line break becomes a <br>. They ran
 * together on one line. Text with any tag is the editor's HTML, as is.
 */
export function plainTextAsHtml(text) {
  const s = String(text);
  // A whole tag (<b>, </p>, <br/>, <!-- -->) is HTML; a stray < (x<y) isn't.
  if (/<\/?[a-zA-Z][^<>]*>|<!--/.test(s) || !/\n/.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}
