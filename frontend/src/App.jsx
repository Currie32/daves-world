import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Cookbooks from './pages/Cookbooks';
import PlaylistGenerator from './pages/PlaylistGenerator';
import Recommendations from './pages/Recommendations';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/cookbooks" element={<Cookbooks />} />
        <Route path="/playlist-generator" element={<PlaylistGenerator />} />
        <Route path="/recommendations" element={<Recommendations />} />
      </Routes>
    </BrowserRouter>
  );
}
