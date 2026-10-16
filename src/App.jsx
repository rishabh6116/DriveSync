import { Routes, Route } from 'react-router-dom';
import IndexPage from './pages/IndexPage.jsx';
import ThemePage from './pages/ThemePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import SetupPage from './pages/SetupPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<IndexPage />} />
        <Route path="/theme" element={<ThemePage />} />
        <Route path="/adminaccount" element={<AdminPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Routes>
      <InstallPrompt />
    </>
  );
}
