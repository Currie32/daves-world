import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Cookbooks from './pages/Cookbooks';
import PlaylistGenerator from './pages/PlaylistGenerator';
import Recommendations from './pages/Recommendations';
import WeatherForecast from './pages/WeatherForecast';
import Layout from './components/Layout';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/cookbooks" element={<Cookbooks />} />
          <Route path="/playlist-generator" element={<PlaylistGenerator />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/weather-forecast" element={<WeatherForecast />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
