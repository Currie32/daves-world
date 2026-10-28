import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Cookbooks from './pages/Cookbooks';
import Recommendations from './pages/Recommendations';
import Weather from './pages/Weather';
import MovieFinder from './pages/MovieFinder';
import TrailPoster from './pages/TrailPoster';
import BookFinder from './pages/BookFinder';
import SP500PE from './pages/SP500PE';
import Events from './pages/Events';
import MortgageCalculator from './pages/MortgageCalculator';
import CityWalkPlanner from './pages/CityWalkPlanner';
import PriceTracker from './pages/PriceTracker';
import BetterSpotify from './pages/BetterSpotify';
import SitesAndBites from './pages/SitesAndBites';
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
          <Route path="/playlist-generator" element={<Navigate to="/better-spotify?tab=playlist" replace />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/weather" element={<Weather />} />
          <Route path="/weather-forecast" element={<Navigate to="/weather" replace />} />
          <Route path="/movie-finder" element={<MovieFinder />} />
          <Route path="/trail-poster" element={<TrailPoster />} />
          <Route path="/book-finder" element={<BookFinder />} />
          <Route path="/sp500-pe" element={<SP500PE />} />
          <Route path="/events" element={<Events />} />
          <Route path="/mortgage-calculator" element={<MortgageCalculator />} />
          <Route path="/city-walk-planner" element={<CityWalkPlanner />} />
          <Route path="/price-tracker" element={<PriceTracker />} />
          <Route path="/better-spotify" element={<BetterSpotify />} />
          <Route path="/sites-and-bites" element={<SitesAndBites />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
