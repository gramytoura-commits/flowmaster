const { runSignupStart } = require('./signup-start');
runSignupStart({
  id: 'kraken', name: 'Kraken', variable: 'KRAKEN_EMAIL', inputLabel: 'email address',
  pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: 'https://www.kraken.com/cs-cz/sign-up',
  input: 'input#email', next: 'button[data-testid="signup-next-button"]',
}).catch(error => { console.error(error.message); process.exitCode = 1; });
