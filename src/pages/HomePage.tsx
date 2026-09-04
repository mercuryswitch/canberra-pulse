import { CesiumView } from '@/components/CesiumView';
import { useAuth } from '@/hooks/AuthContext';

export function HomePage() {
  const { signOut } = useAuth();

  return (
    <div className="relative">
      <CesiumView />
      <button
        onClick={() => void signOut()}
        className="absolute top-4 right-40 text-white bg-gray-900/70 hover:bg-gray-900 transition-colors text-xs rounded-lg px-3 py-2 z-10"
        aria-label="Sign out"
      >
        Sign out
      </button>
    </div>
  );
}
