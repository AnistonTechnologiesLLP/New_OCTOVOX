import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomAcoustics } from './components/RoomAcoustics';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <RoomAcoustics />
  </StrictMode>,
);
