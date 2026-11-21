import app from './app.js';
import config from './config.js';

app.listen(config.port, () => {
  console.log(`Document chatbot running at http://localhost:${config.port}`);
  if (!config.googleApiKey) {
    console.warn('GOOGLE_API_KEY is not set. Uploads work, but chat answers need a key (see README).');
  }
});
