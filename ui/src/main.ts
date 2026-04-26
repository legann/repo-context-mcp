import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/app.css';
import { RepoContextViewer } from './viewer-app.js';

const viewer = new RepoContextViewer();
viewer.init();
viewer.connectSSE();
