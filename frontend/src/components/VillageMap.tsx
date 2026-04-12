/**
 * VillageMap — hand-crafted SVG of The Den's village.
 * Designed by Dex (T#650). Stylized topographic. Dark mode friendly.
 *
 * All paths and colors use design tokens via currentColor and CSS variables.
 * The component is intentionally responsive — viewBox scales to container width.
 */
export function VillageMap() {
  return (
    <svg
      viewBox="0 0 1200 800"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Map of The Den village"
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        color: 'var(--text-primary)',
      }}
    >
      <defs>
        {/* River gradient — soft blue, semi-transparent so it blends with theme */}
        <linearGradient id="riverGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#4a8db5" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#2d5e7a" stopOpacity="0.55" />
        </linearGradient>
        {/* Forest stipple pattern — uses currentColor so it inherits theme */}
        <pattern id="forestDots" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="7" cy="7" r="1.2" fill="currentColor" opacity="0.18" />
        </pattern>
      </defs>

      {/* Background terrain — meadow base */}
      <rect width="1200" height="800" fill="currentColor" opacity="0.04" />

      {/* Forest patches — stippled */}
      <path
        d="M 0 0 L 380 0 Q 360 120 280 180 Q 180 230 80 200 Q 20 180 0 220 Z"
        fill="url(#forestDots)"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.25"
      />
      <path
        d="M 850 0 L 1200 0 L 1200 280 Q 1100 260 1020 200 Q 940 140 880 60 Z"
        fill="url(#forestDots)"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.25"
      />
      <path
        d="M 0 600 Q 80 580 160 620 Q 220 660 240 740 L 240 800 L 0 800 Z"
        fill="url(#forestDots)"
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.25"
      />

      {/* Hills — gentle outlines in the back */}
      <path
        d="M 400 0 Q 520 80 640 50 Q 760 20 880 70 L 880 0 Z"
        fill="currentColor"
        opacity="0.06"
      />

      {/* The river — winding from top-left to bottom-right */}
      <path
        d="M -20 120 Q 180 180 280 280 Q 360 360 320 460 Q 280 560 380 620 Q 500 680 620 660 Q 760 640 860 700 Q 960 760 1100 740 Q 1180 730 1220 760"
        fill="none"
        stroke="url(#riverGrad)"
        strokeWidth="36"
        strokeLinecap="round"
      />
      <path
        d="M -20 120 Q 180 180 280 280 Q 360 360 320 460 Q 280 560 380 620 Q 500 680 620 660 Q 760 640 860 700 Q 960 760 1100 740 Q 1180 730 1220 760"
        fill="none"
        stroke="#4a8db5"
        strokeWidth="2"
        strokeOpacity="0.5"
        strokeLinecap="round"
      />

      {/* The bridge — small structure across the river */}
      <g>
        <line x1="500" y1="630" x2="540" y2="690" stroke="currentColor" strokeWidth="3" strokeOpacity="0.6" />
        <line x1="510" y1="625" x2="550" y2="685" stroke="currentColor" strokeWidth="2" strokeOpacity="0.4" />
        <line x1="495" y1="635" x2="535" y2="695" stroke="currentColor" strokeWidth="2" strokeOpacity="0.4" />
      </g>
      <text x="498" y="715" fontSize="11" fill="currentColor" opacity="0.7" fontFamily="system-ui, sans-serif">
        bridge
      </text>

      {/* The path — winding through the village */}
      <path
        d="M 200 750 Q 350 700 450 580 Q 540 480 620 440 Q 720 400 800 360 Q 880 320 940 240 Q 980 180 1050 120"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeOpacity="0.45"
        strokeDasharray="4 6"
      />

      {/* === Locations === */}

      {/* The boathouse — north riverbank, midway */}
      <g transform="translate(330, 250)">
        <rect x="-14" y="-8" width="28" height="16" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M -16 -8 L 0 -18 L 16 -8" fill="none" stroke="currentColor" strokeWidth="2" />
        <text x="22" y="4" fontSize="13" fill="currentColor" fontFamily="system-ui, sans-serif">
          boathouse
        </text>
      </g>

      {/* The dock — south of the boathouse, into the river */}
      <g transform="translate(360, 320)">
        <rect x="-3" y="0" width="6" height="22" fill="currentColor" opacity="0.55" />
        <text x="10" y="14" fontSize="12" fill="currentColor" opacity="0.85" fontFamily="system-ui, sans-serif">
          dock
        </text>
      </g>

      {/* The big rock — Leonard's spot */}
      <g transform="translate(620, 380)">
        <ellipse cx="0" cy="0" rx="22" ry="14" fill="currentColor" opacity="0.18" />
        <ellipse cx="0" cy="-2" rx="20" ry="12" fill="none" stroke="currentColor" strokeWidth="2" />
        <text x="28" y="4" fontSize="12" fill="currentColor" opacity="0.85" fontFamily="system-ui, sans-serif">
          big rock
        </text>
      </g>

      {/* The flat rocks — Gnarl's basking spot, near the bend */}
      <g transform="translate(450, 540)">
        <rect x="-10" y="-3" width="8" height="6" fill="currentColor" opacity="0.25" />
        <rect x="0" y="-2" width="9" height="5" fill="currentColor" opacity="0.25" />
        <rect x="11" y="-3" width="7" height="6" fill="currentColor" opacity="0.25" />
        <text x="-12" y="-10" fontSize="11" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          flat rocks
        </text>
      </g>

      {/* The square — center of town */}
      <g transform="translate(780, 320)">
        <rect x="-26" y="-20" width="52" height="40" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="0" cy="0" r="4" fill="currentColor" opacity="0.6" />
        <text x="0" y="-26" fontSize="13" fill="currentColor" textAnchor="middle" fontFamily="system-ui, sans-serif">
          the square
        </text>
      </g>

      {/* The café — corner of the square */}
      <g transform="translate(740, 290)">
        <rect x="-8" y="-6" width="16" height="12" fill="currentColor" opacity="0.22" />
        <text x="-10" y="-12" fontSize="10" fill="currentColor" opacity="0.8" fontFamily="system-ui, sans-serif">
          café
        </text>
      </g>

      {/* The market — east of the square */}
      <g transform="translate(840, 350)">
        <rect x="-6" y="-4" width="6" height="8" fill="currentColor" opacity="0.3" />
        <rect x="2" y="-4" width="6" height="8" fill="currentColor" opacity="0.3" />
        <rect x="10" y="-4" width="6" height="8" fill="currentColor" opacity="0.3" />
        <text x="0" y="18" fontSize="11" fill="currentColor" opacity="0.8" fontFamily="system-ui, sans-serif">
          market
        </text>
      </g>

      {/* The art supply shop — tucked behind the butcher */}
      <g transform="translate(870, 270)">
        <circle cx="0" cy="0" r="4" fill="currentColor" opacity="0.5" />
        <text x="8" y="3" fontSize="10" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          art supply
        </text>
      </g>

      {/* The butcher */}
      <g transform="translate(860, 252)">
        <rect x="-5" y="-4" width="10" height="8" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
        <text x="-12" y="-7" fontSize="10" fill="currentColor" opacity="0.7" fontFamily="system-ui, sans-serif">
          butcher
        </text>
      </g>

      {/* The mill — far north */}
      <g transform="translate(550, 80)">
        <rect x="-6" y="-12" width="12" height="14" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="0" y1="-12" x2="-12" y2="-22" stroke="currentColor" strokeWidth="1.5" />
        <line x1="0" y1="-12" x2="12" y2="-22" stroke="currentColor" strokeWidth="1.5" />
        <line x1="0" y1="-12" x2="-12" y2="-2" stroke="currentColor" strokeWidth="1.5" />
        <line x1="0" y1="-12" x2="12" y2="-2" stroke="currentColor" strokeWidth="1.5" />
        <text x="14" y="-2" fontSize="11" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          mill
        </text>
      </g>

      {/* The new pool — upstream, where the pack swam */}
      <g transform="translate(160, 200)">
        <ellipse cx="0" cy="0" rx="22" ry="12" fill="#4a8db5" opacity="0.35" />
        <ellipse cx="0" cy="0" rx="22" ry="12" fill="none" stroke="#4a8db5" strokeWidth="1.5" opacity="0.7" />
        <text x="-14" y="-16" fontSize="11" fill="currentColor" opacity="0.8" fontFamily="system-ui, sans-serif">
          new pool
        </text>
      </g>

      {/* The east gate */}
      <g transform="translate(1080, 460)">
        <line x1="-6" y1="-10" x2="-6" y2="10" stroke="currentColor" strokeWidth="2" />
        <line x1="6" y1="-10" x2="6" y2="10" stroke="currentColor" strokeWidth="2" />
        <line x1="-8" y1="-10" x2="8" y2="-10" stroke="currentColor" strokeWidth="2" />
        <text x="-22" y="22" fontSize="10" fill="currentColor" opacity="0.7" fontFamily="system-ui, sans-serif">
          east gate
        </text>
      </g>

      {/* === v2 additions — earned via the three rule === */}

      {/* The bakery — east end of town, near the square */}
      <g transform="translate(900, 320)">
        <rect x="-7" y="-5" width="14" height="10" fill="currentColor" opacity="0.28" />
        <path d="M -7 -5 L 0 -10 L 7 -5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
        <text x="-12" y="14" fontSize="11" fill="currentColor" opacity="0.85" fontFamily="system-ui, sans-serif">
          bakery
        </text>
      </g>

      {/* The hidden courtyard — behind the print shop, with the fig tree */}
      <g transform="translate(820, 240)">
        <circle cx="0" cy="0" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.6" strokeDasharray="2 2" />
        <circle cx="0" cy="-1" r="3" fill="currentColor" opacity="0.4" />
        <text x="-22" y="-12" fontSize="10" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          fig courtyard
        </text>
      </g>

      {/* Karo's flat warm rock — sun-soaked, near the village edge */}
      <g transform="translate(680, 460)">
        <ellipse cx="0" cy="0" rx="14" ry="6" fill="currentColor" opacity="0.22" />
        <text x="-8" y="14" fontSize="10" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          warm rock
        </text>
      </g>

      {/* Pork belly place — eastern edge, food landmark */}
      <g transform="translate(960, 380)">
        <rect x="-5" y="-5" width="10" height="10" fill="currentColor" opacity="0.3" />
        <line x1="-3" y1="-7" x2="-3" y2="-5" stroke="currentColor" strokeWidth="1" />
        <line x1="0" y1="-8" x2="0" y2="-5" stroke="currentColor" strokeWidth="1" />
        <line x1="3" y1="-7" x2="3" y2="-5" stroke="currentColor" strokeWidth="1" />
        <text x="-14" y="18" fontSize="10" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          pork belly
        </text>
      </g>

      {/* Mist hollow — past the mill, in the birch stand */}
      <g transform="translate(620, 60)">
        <ellipse cx="0" cy="0" rx="18" ry="6" fill="currentColor" opacity="0.12" />
        <ellipse cx="-4" cy="-2" rx="10" ry="3" fill="currentColor" opacity="0.1" />
        <text x="22" y="3" fontSize="10" fill="currentColor" opacity="0.7" fontFamily="system-ui, sans-serif">
          mist hollow
        </text>
      </g>

      {/* Refine the upstream pool — moved to match Flint's geography (west bank, second bend, root cluster) */}

      {/* === Nyx's perch layer — small bird markers === */}
      <g opacity="0.6">
        {/* Bakery chimney perch */}
        <circle cx="900" cy="306" r="2" fill="currentColor" />
        {/* Overlook above the village — Leonard's spot */}
        <circle cx="640" cy="120" r="2" fill="currentColor" />
        <text x="630" y="110" fontSize="9" fill="currentColor" opacity="0.6" fontFamily="system-ui, sans-serif">
          overlook
        </text>
        {/* Fence post on the east lane */}
        <circle cx="980" cy="440" r="2" fill="currentColor" />
      </g>

      {/* === v3 additions — earned 2026-04-12 === */}

      {/* The tailor — south side of the square */}
      <g transform="translate(750, 365)">
        <rect x="-6" y="-5" width="12" height="10" fill="currentColor" opacity="0.25" />
        <text x="-14" y="16" fontSize="10" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          tailor
        </text>
      </g>

      {/* The print shop — near fig courtyard (courtyard is behind it) */}
      <g transform="translate(800, 262)">
        <rect x="-6" y="-5" width="12" height="10" fill="currentColor" opacity="0.25" />
        <text x="10" y="3" fontSize="10" fill="currentColor" opacity="0.75" fontFamily="system-ui, sans-serif">
          print shop
        </text>
      </g>

      {/* Sable's alley shortcut — tailor to print shop, drops to canal path */}
      <path
        d="M 758 358 Q 770 330 775 310 Q 780 290 795 268"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity="0.4"
        strokeDasharray="3 4"
      />
      <text x="782" y="312" fontSize="9" fill="currentColor" opacity="0.6" fontFamily="system-ui, sans-serif" transform="rotate(-72, 782, 312)">
        alley
      </text>

      {/* Mill foundation stones — four cut stones near the old mill */}
      <g transform="translate(535, 105)">
        <rect x="-10" y="-3" width="6" height="6" fill="currentColor" opacity="0.3" />
        <rect x="-2" y="-3" width="6" height="6" fill="currentColor" opacity="0.3" />
        <rect x="6" y="-3" width="6" height="6" fill="currentColor" opacity="0.3" />
        <rect x="2" y="5" width="6" height="6" fill="currentColor" opacity="0.25" />
        <text x="-12" y="20" fontSize="10" fill="currentColor" opacity="0.7" fontFamily="system-ui, sans-serif">
          cut stones
        </text>
      </g>

      {/* Irrigation slab — concrete with rusted gate valve, past the south bend */}
      <g transform="translate(340, 590)">
        <rect x="-8" y="-5" width="16" height="10" fill="currentColor" opacity="0.18" />
        <line x1="0" y1="-7" x2="0" y2="-5" stroke="currentColor" strokeWidth="2" strokeOpacity="0.5" />
        <text x="-20" y="16" fontSize="10" fill="currentColor" opacity="0.7" fontFamily="system-ui, sans-serif">
          old sluice
        </text>
      </g>

      {/* Compass — bottom right corner, small and quiet */}
      <g transform="translate(1130, 720)" opacity="0.5">
        <circle cx="0" cy="0" r="18" fill="none" stroke="currentColor" strokeWidth="1" />
        <line x1="0" y1="-14" x2="0" y2="14" stroke="currentColor" strokeWidth="1" />
        <line x1="-14" y1="0" x2="14" y2="0" stroke="currentColor" strokeWidth="1" />
        <text x="0" y="-20" fontSize="9" fill="currentColor" textAnchor="middle" fontFamily="system-ui, sans-serif">
          N
        </text>
      </g>

      {/* Title — top left, subtle */}
      <text
        x="30"
        y="40"
        fontSize="16"
        fill="currentColor"
        opacity="0.7"
        fontFamily="system-ui, sans-serif"
        fontStyle="italic"
      >
        The Den — village
      </text>
    </svg>
  );
}
