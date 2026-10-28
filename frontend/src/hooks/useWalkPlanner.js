import { useCallback, useRef } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

// Proxies Places Nearby Search + Routes API through Cloud Functions so the
// Google Maps API key stays server-side, same pattern as usePlacesAutocomplete.
export function useWalkPlanner() {
  const functions = useRef(getFunctions(app, 'us-west1'));

  const searchNearby = useCallback(async ({ lat, lng, radius, includedTypes, maxResultCount }) => {
    try {
      const fn = httpsCallable(functions.current, 'nearby_places');
      const result = await fn({ lat, lng, radius, includedTypes, maxResultCount });
      return result.data?.places || [];
    } catch {
      return [];
    }
  }, []);

  const getDirections = useCallback(async ({ origin, destination, intermediates, mode, optimize }) => {
    try {
      const fn = httpsCallable(functions.current, 'walk_directions');
      const result = await fn({ origin, destination, intermediates, mode, optimize });
      return result.data || null;
    } catch {
      return null;
    }
  }, []);

  return { searchNearby, getDirections };
}
