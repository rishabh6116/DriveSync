import { useLayoutEffect } from 'react';
import bodyHtml from './AdminPage.body.html?raw';
import pageCss from '../styles/admin.page.css?raw';
import { initAdminPage } from './AdminPage.script.js';

export default function AdminPage() {
  useLayoutEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-page', 'admin');
    styleEl.textContent = pageCss;
    document.head.appendChild(styleEl);

    initAdminPage();

    return () => {
      styleEl.remove();
    };
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />;
}
