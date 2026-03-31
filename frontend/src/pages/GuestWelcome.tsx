import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import styles from './GuestWelcome.module.css';

export function GuestWelcome() {
  const { guestName } = useAuth();

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Welcome to The Den</h1>
        <p className={styles.greeting}>
          Hey {guestName || 'Guest'} — glad you're here.
        </p>

        <div className={styles.nav}>
          <Link to="/" className={styles.navItem}>
            <span className={styles.navIcon}>🐾</span>
            <span className={styles.navLabel}>Pack</span>
            <span className={styles.navDesc}>Meet the Beasts</span>
          </Link>
          <Link to="/forum" className={styles.navItem}>
            <span className={styles.navIcon}>💬</span>
            <span className={styles.navLabel}>Forum</span>
            <span className={styles.navDesc}>Join the conversation</span>
          </Link>
          <Link to="/dms" className={styles.navItem}>
            <span className={styles.navIcon}>✉️</span>
            <span className={styles.navLabel}>DM</span>
            <span className={styles.navDesc}>Direct messages</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
