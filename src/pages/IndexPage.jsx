import { useLayoutEffect } from 'react';
import bodyHtml from './IndexPage.body.html?raw';
import pageCss from '../styles/index.page.css?raw';
import { initIndexPage } from './IndexPage.script.js';

export default function IndexPage() {
  useLayoutEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-page', 'index');
    styleEl.textContent = pageCss;
    document.head.appendChild(styleEl);

    initIndexPage();

    return () => {
      styleEl.remove();
    };
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />;
}
