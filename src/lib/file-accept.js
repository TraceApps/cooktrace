// File pickers whose accept list names an extension Android has no type
// for (.paprikarecipes, .paprikarecipe). The Android app's picker turns each
// extension into a MIME type and silently drops the ones it doesn't know, so
// those files show greyed out and can't be picked (cooktrace#98). There the
// picker shows every file and the pick is checked against the list instead.

/** The accept attribute to use: the list in a browser, every file in the app. */
export function pickerAccept(accept, native) {
  return native ? '' : accept;
}

/** True when the file's name ends in one of the list's extensions, or its type is one of the list's types. */
export function fileMatchesAccept(file, accept) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  return String(accept || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .some(a => a.startsWith('.') ? name.endsWith(a) : (type && type === a));
}
