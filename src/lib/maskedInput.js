// Browsers offer to save "passwords" based on <input type="password">,
// regardless of autocomplete="off" (modern Chrome/Edge/Firefox ignore that
// attribute specifically for password managers). The only reliable way to
// stop the save-password prompt is to not use type="password" at all.
//
// This swaps the input to type="text" and visually masks it with
// -webkit-text-security (supported in Chrome, Edge, Safari — covers the
// vast majority of users who'd see the save-password popup). For browsers
// without that CSS property (Firefox), it falls back to manually replacing
// the displayed characters with dots while tracking the real value
// separately, so nothing is lost either way.

export function attachMaskedInput(input) {
  if (!input || input.dataset.maskedInput === 'true') return;
  input.dataset.maskedInput = 'true';

  input.type = 'text';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('data-lpignore', 'true'); // hint some password managers respect
  input.setAttribute('data-1p-ignore', 'true');
  input.classList.add('passcode-mask');

  const supportsWebkitMask =
    typeof CSS !== 'undefined' && CSS.supports && CSS.supports('-webkit-text-security', 'disc');

  if (supportsWebkitMask) {
    // Purely visual masking — input.value stays the real typed value.
    return;
  }

  // Manual fallback for browsers without -webkit-text-security.
  let realValue = '';
  input.dataset.realValue = '';

  input.addEventListener('input', () => {
    const cursor = input.selectionStart ?? input.value.length;
    const displayed = input.value;

    if (displayed.length > realValue.length) {
      const inserted = displayed.slice(cursor - (displayed.length - realValue.length), cursor);
      realValue = realValue.slice(0, cursor - inserted.length) + inserted + realValue.slice(cursor - inserted.length);
    } else if (displayed.length < realValue.length) {
      const removedCount = realValue.length - displayed.length;
      realValue = realValue.slice(0, cursor) + realValue.slice(cursor + removedCount);
    } else {
      realValue = realValue.slice(0, displayed.length);
    }

    input.dataset.realValue = realValue;
    input.value = '•'.repeat(realValue.length);
    input.setSelectionRange(cursor, cursor);
  });
}

export function getMaskedValue(input) {
  if (!input) return '';
  return input.dataset.realValue !== undefined && input.dataset.realValue !== ''
    ? input.dataset.realValue
    : input.value;
}

export function clearMaskedInput(input) {
  if (!input) return;
  input.value = '';
  if (input.dataset.realValue !== undefined) input.dataset.realValue = '';
}
