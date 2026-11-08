const { runSignupStart } = require('./signup-start');
runSignupStart({
  id: 'outlook', name: 'Outlook.com', variable: 'OUTLOOK_USERNAME', inputLabel: 'username',
  pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
  url: 'https://signup.live.com/signup?lic=1&uaid=&domain=outlook.com',
  input: 'input#floatingLabelInput5, input[name="MemberName"], input#MemberName, input[type="email"]',
  next: 'button[data-testid="primaryButton"], input#iSignupAction, button[type="submit"]',
}).catch(error => { console.error(error.message); process.exitCode = 1; });
