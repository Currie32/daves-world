import { useCallback, useRef } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

// Proxies Places Autocomplete/Details through Cloud Functions so the Google
// Maps API key stays server-side instead of being embedded in the page via
// the Maps JavaScript SDK.
export function usePlacesAutocomplete() {
  const functions = useRef(getFunctions(app, 'us-west1'));

  const predict = useCallback(async (input, regionCodes) => {
    if (!input.trim()) return [];
    try {
      const fn = httpsCallable(functions.current, 'places_autocomplete');
      const result = await fn(regionCodes !== undefined ? { input, regionCodes } : { input });
      return result.data?.predictions || [];
    } catch {
      return [];
    }
  }, []);

  const getDetails = useCallback(async (placeId) => {
    try {
      const fn = httpsCallable(functions.current, 'place_details');
      const result = await fn({ placeId });
      return result.data?.lat != null ? result.data : null;
    } catch {
      return null;
    }
  }, []);

  return { ready: true, predict, getDetails };
}
