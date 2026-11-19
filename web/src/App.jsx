import { Route, Routes } from 'react-router-dom';
import { PublicLayout } from './components/Layout.jsx';
import Home from './pages/Home.jsx';
import ComingSoon from './pages/ComingSoon.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<Home />} />
        <Route path="*" element={<ComingSoon title="Page coming soon" />} />
      </Route>
    </Routes>
  );
}
