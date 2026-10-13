import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Cookbooks from './pages/Cookbooks';
import PlaylistGenerator from './pages/PlaylistGenerator';
import Recommendations from './pages/Recommendations';
import WeatherForecast from './pages/WeatherForecast';
import MovieFinder from './pages/MovieFinder';
import TrailPoster from './pages/TrailPoster';
import BookFinder from './pages/BookFinder';
import SP500PE from './pages/SP500PE';
import Events from './pages/Events';
import MortgageCalculator from './pages/MortgageCalculator';
import BetterSpotify from './pages/BetterSpotify';
import Layout from './components/Layout';
import UpdatePrompt from './components/UpdatePrompt';

export default function App() {
  return (
    <BrowserRouter>
      <UpdatePrompt />
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/recipes" element={<Cookbooks />} />
          <Route path="/cookbooks" element={<Navigate to="/recipes" replace />} />
          <Route path="/playlist-generator" element={<PlaylistGenerator />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/weather-forecast" element={<WeatherForecast />} />
          <Route path="/movie-finder" element={<MovieFinder />} />
          <Route path="/trail-poster" element={<TrailPoster />} />
          <Route path="/book-finder" element={<BookFinder />} />
          <Route path="/sp500-pe" element={<SP500PE />} />
          <Route path="/events" element={<Events />} />
          <Route path="/mortgage-calculator" element={<MortgageCalculator />} />
          <Route path="/better-spotify" element={<BetterSpotify />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
