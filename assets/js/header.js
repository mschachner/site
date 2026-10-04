// SVG Icons (decorative: the button's aria-label carries the meaning)
const moonIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
const sunIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;

// Apply theme immediately to prevent flash.
// A saved choice wins; otherwise follow the operating system's light/dark setting.
(function() {
  const savedTheme = localStorage.getItem('theme');
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const theme = savedTheme || (prefersLight ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
  // Temporarily disable transitions to prevent flash
  document.documentElement.classList.add('no-transition');
  window.addEventListener('load', () => {
    // Force a reflow
    document.body.offsetHeight;
    // Re-enable transitions after a small delay
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('no-transition');
    });
  });
})();

let appHeader = `
      <a class="skip-link" href="#main-content">Skip to content</a>
      <nav aria-label="Site">
        <div class="nav-top">
          <h1><a href="index.html" class="navbar">Mark Schachner</a></h1>
          <button id="theme-toggle" type="button" aria-label="Switch to light mode">
            <span id="theme-icon">${moonIcon}</span>
          </button>
        </div>
        <ul>
          <li><a class="navbar fancy-underline" href="index.html">
            Home</a></li>
          <li><a class="navbar fancy-underline" href="research.html">
            Research</a></li>
          <li><a class="navbar fancy-underline" href="teaching_outreach.html">
            Teaching & outreach</a></li>
          <li><a class="navbar fancy-underline" href="logsem.html">
            Logic student seminar </a></li>
          <li><a class="navbar fancy-underline" href="movienight.html">
            Movie night</a></li>
          <li><a class="navbar fancy-underline" href="projects.html">
            Personal projects</a></li>
        </ul>
        </nav>
`;

document.getElementById("app-header").innerHTML = appHeader;

// Skip link: point at this page's <main>, whatever its id, and make it focusable
const mainEl = document.querySelector('main');
if (mainEl) {
  if (!mainEl.id) mainEl.id = 'main-content';
  mainEl.tabIndex = -1;
  document.querySelector('.skip-link').setAttribute('href', '#' + mainEl.id);
}

// Mark the current page in the nav
const currentPage = location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('nav ul a').forEach(link => {
  if (link.getAttribute('href') === currentPage) {
    link.setAttribute('aria-current', 'page');
  }
});

// Expose the rendered nav height to CSS (sticky season headings, scroll-padding)
const navEl = document.querySelector('nav');
function setHeaderHeight() {
  document.documentElement.style.setProperty('--header-height', navEl.offsetHeight + 'px');
}
setHeaderHeight();
if (window.ResizeObserver) {
  new ResizeObserver(setHeaderHeight).observe(navEl);
} else {
  window.addEventListener('resize', setHeaderHeight);
}

// Theme toggle functionality
const toggleButton = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');

// Icon shows the current theme; label says what pressing will do
function applyTheme(theme) {
  if (theme === 'light') {
    themeIcon.innerHTML = sunIcon;
    toggleButton.setAttribute('aria-label', 'Switch to dark mode');
  } else {
    themeIcon.innerHTML = moonIcon;
    toggleButton.setAttribute('aria-label', 'Switch to light mode');
  }
}

applyTheme(document.documentElement.getAttribute('data-theme'));

toggleButton.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  applyTheme(next);
});
