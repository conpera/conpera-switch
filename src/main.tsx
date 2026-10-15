import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './motion.css';

if (navigator.userAgent.includes('ConperaSwitchMac/')) document.documentElement.dataset.native = 'mac';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
