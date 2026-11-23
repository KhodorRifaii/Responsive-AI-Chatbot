// Apply the saved theme before the page paints to avoid a flash. Loaded as a blocking
// script in <head> (not inline), so the Content Security Policy needs no 'unsafe-inline'.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('docchat-theme'); } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-bs-theme', theme);
})();
