import { useAuth } from '../hooks/useAuth';

export default function AdminGate({ children }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return null;
  return children;
}
