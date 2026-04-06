import { VillageMap } from '../components/VillageMap';
import styles from './Village.module.css';

export function Village() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>The Village</h1>
        <p className={styles.credit}>Map by Dex</p>
      </div>
      <div className={styles.mapContainer}>
        <VillageMap />
      </div>
    </div>
  );
}
