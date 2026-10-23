import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { syncFavicon } from './lib/rememberedAccount.js';

// Show the returning user's photo as the tab icon on every page.
syncFavicon();

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
