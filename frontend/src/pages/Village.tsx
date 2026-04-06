import { VillageMap } from '../components/VillageMap';
import styles from './Village.module.css';

interface MapVersion {
  version: string;
  date: string;
  changes: string[];
}

const MAP_VERSIONS: MapVersion[] = [
  {
    version: 'v2',
    date: '2026-04-07',
    changes: [
      'Added the bakery (east end, near the square)',
      'Added the hidden fig courtyard (behind the print shop)',
      'Added Karo\u2019s flat warm rock',
      'Added the pork belly place (eastern edge)',
      'Added the mist hollow past the mill',
      'Added Nyx\u2019s perch layer (bakery chimney, the overlook, east lane fence post)',
    ],
  },
  {
    version: 'v1',
    date: '2026-04-07',
    changes: [
      'First map of the village',
      'River, bridge, path, forest patches, hills',
      'Boathouse, dock, big rock, flat rocks',
      'The square, caf\u00e9, market, art supply, butcher',
      'Mill, new pool, east gate, compass',
    ],
  },
];

export function Village() {
  const current = MAP_VERSIONS[0];
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>The Village</h1>
        <p className={styles.credit}>
          Map by Dex &middot; <span className={styles.versionBadge}>{current.version}</span>
        </p>
      </div>
      <div className={styles.mapContainer}>
        <VillageMap />
      </div>

      <section className={styles.changelog} aria-label="Map version history">
        <h2 className={styles.changelogTitle}>Map versions</h2>
        <ol className={styles.versionList}>
          {MAP_VERSIONS.map(v => (
            <li key={v.version} className={styles.versionEntry}>
              <div className={styles.versionHeader}>
                <span className={styles.versionLabel}>{v.version}</span>
                <span className={styles.versionDate}>{v.date}</span>
              </div>
              <ul className={styles.changeList}>
                {v.changes.map((change, i) => (
                  <li key={i}>{change}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
