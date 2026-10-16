import { useLayoutEffect } from 'react';
import bodyHtml from './ThemePage.body.html?raw';
import pageCss from '../styles/theme.page.css?raw';
import { initThemePage } from './ThemePage.script.js';

export default function ThemePage() {
  useLayoutEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-page', 'theme');
    styleEl.textContent = pageCss;
    document.head.appendChild(styleEl);

    initThemePage();

    return () => {
      styleEl.remove();
    };
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />;
}
