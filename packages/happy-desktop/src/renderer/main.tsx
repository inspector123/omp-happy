import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initBridge } from './api';
import './styles.css';

void initBridge();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
