// SVG Icons
const moonIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
const sunIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;

// Apply theme immediately to prevent flash
(function() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
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
  }
})();

let appHeader = `
      <nav>
        <div style="display: flex; justify-content: space-between; align-items: center; padding-right: 20px;">
          <h1><a href="index.html" class="navbar"> Mark Schachner </a></h1>
          <button id="theme-toggle" aria-label="Toggle Dark Mode" style="background:none; border:none; cursor:pointer; padding: 0; color: #FAEBD7; display: flex; align-items: center;">
            <span id="theme-icon">${moonIcon}</span>
          </button>
        </div>
        <ul>
          <li><a class= "navbar fancy-underline" href="index.html">
            Home</a></li>
          <li><a class= "navbar fancy-underline" href="research.html">
            Research</a></li>
          <li><a class= "navbar fancy-underline" href="teaching_outreach.html">
            Teaching & outreach</a></li>
          <li><a class= "navbar fancy-underline" href="logsem.html">
            Logic student seminar </a></li>
          <li><a class= "navbar fancy-underline" href="movienight.html">
            Movie night</a></li>
          <li><a class= "navbar fancy-underline" href="projects.html">
            Personal projects</a></li>
        </ul>
        </nav>
`;

document.getElementById("app-header").innerHTML = appHeader;

// Theme toggle functionality
const toggleButton = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');

// Check for saved user preference
const currentTheme = localStorage.getItem('theme');

// Function to update icon based on theme
function updateIcon(theme) {
  if (theme === 'light') {
    themeIcon.innerHTML = sunIcon;
  } else {
    themeIcon.innerHTML = moonIcon;
  }
}

if (currentTheme) {
  updateIcon(currentTheme);
}

toggleButton.addEventListener('click', () => {
  let theme = document.documentElement.getAttribute('data-theme');
  
  if (theme === 'light') {
    theme = 'dark';
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  } else {
    theme = 'light';
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('theme', 'light');
  }
  
  updateIcon(theme);
});
