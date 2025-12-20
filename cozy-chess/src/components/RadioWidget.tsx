import React, { useEffect, useRef, useState } from "react";

type RadioTrack = {
  id: string;
  label: string;
};

const RADIO_TRACKS: RadioTrack[] = [
  { id: "bhWcwXm1Zrg", label: "Chill Reggae Mix" },
  { id: "qAo2UhZq0pY", label: "Amapiano Afrobeat" },
  { id: "UZ6c5tuxCeI", label: "Deep Space Ambient" },
  { id: "trYUo0ZVOjM", label: "ChillStep Mix 2025" },
  { id: "T1kMZBH47eU", label: "Sad Chill Lofi Beats" },
  { id: "tcbcEEezEOA", label: "Lofi Study Session" },
  { id: "OOpJhWWJVBE", label: "Hip Hop Beats" },
  { id: "j8zg33T9izY", label: "Dope City Kings" },
  { id: "ugVyIVxV6Ss", label: "Xmas Lofi Vibes" },
  { id: "5zkKS2Cfuh8", label: "Relaxing Chill Lofi" },
  { id: "y1q9zMwZYAg", label: "JazzHop Mix" },
  { id: "9Dh6UAJpKTo", label: "Dreamscape Mix" },
  { id: "n5tPs_UKydg", label: "R&B Beats" },
  { id: "oTrN9yAV45w", label: "Lofi Rainy" },
  { id: "1vAteHUZ4bQ", label: "Relaxing Smooth Jazz" }
];

function getRandomTrackIndex(excludeIndex?: number): number {
  if (RADIO_TRACKS.length === 0) {
    return 0;
  }
  if (RADIO_TRACKS.length === 1) {
    return 0;
  }

  let next = excludeIndex;
  while (next === excludeIndex) {
    next = Math.floor(Math.random() * RADIO_TRACKS.length);
  }
  return next ?? 0;
}

export const RadioWidget: React.FC = () => {
  const [currentIndex, setCurrentIndex] = useState<number>(() =>
    RADIO_TRACKS.length > 0
      ? Math.floor(Math.random() * RADIO_TRACKS.length)
      : 0
  );
  const [playerReady, setPlayerReady] = useState(false);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any | null>(null);

  // Load the YouTube IFrame API and create the player once.
  useEffect(() => {
    let isCancelled = false;

    const createPlayer = () => {
      if (
        isCancelled ||
        playerRef.current ||
        !playerContainerRef.current ||
        !(window as any).YT ||
        !(window as any).YT.Player
      ) {
        return;
      }

      const YT = (window as any).YT;
      const initialTrack = RADIO_TRACKS[currentIndex];

      playerRef.current = new YT.Player(playerContainerRef.current, {
        videoId: initialTrack?.id,
        playerVars: {
          autoplay: 1,
          controls: 0,
          rel: 0,
          modestbranding: 1
        },
        events: {
          onReady: () => {
            if (!isCancelled) {
              setPlayerReady(true);
            }
          },
          onStateChange: (event: any) => {
            if (!YT || !YT.PlayerState) {
              return;
            }
            if (event.data === YT.PlayerState.ENDED) {
              setCurrentIndex((prev) => getRandomTrackIndex(prev));
            }
          }
        }
      });
    };

    if ((window as any).YT && (window as any).YT.Player) {
      createPlayer();
    } else {
      (window as any).onYouTubeIframeAPIReady = () => {
        createPlayer();
      };

      const existingScript = document.getElementById("youtube-iframe-api");
      if (!existingScript) {
        const tag = document.createElement("script");
        tag.id = "youtube-iframe-api";
        tag.src = "https://www.youtube.com/iframe_api";
        document.body.appendChild(tag);
      }
    }

    return () => {
      isCancelled = true;
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, []);

  // Whenever the selected track changes and the player is ready, load it.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !playerReady) {
      return;
    }

    const nextTrack = RADIO_TRACKS[currentIndex];
    if (nextTrack) {
      player.loadVideoById(nextTrack.id);
    }
  }, [currentIndex, playerReady]);

  const handleSelectChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    const index = RADIO_TRACKS.findIndex((track) => track.id === value);
    if (index !== -1) {
      setCurrentIndex(index);
    }
  };

  const handleNextClick = () => {
    setCurrentIndex((prev) => getRandomTrackIndex(prev));
  };

  const currentTrack = RADIO_TRACKS[currentIndex];

  return (
    <section className="cozy-radio-card">
    
      <div className="cozy-radio-row">
        <div className="cozy-radio-station">
          <label className="cozy-label">
            <select
              className="cozy-select"
              value={currentTrack?.id ?? ""}
              onChange={handleSelectChange}
              disabled={!playerReady}
            >
              {RADIO_TRACKS.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          className="cozy-btn secondary"
          onClick={handleNextClick}
          disabled={!playerReady || RADIO_TRACKS.length < 2}
        >
          Next
        </button>
      </div>

      {/* Hidden YouTube player – audio only */}
      <div
        ref={playerContainerRef}
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          overflow: "hidden",
          pointerEvents: "none",
          opacity: 0
        }}
      />

      <div className="cozy-radio-meta">
        {currentTrack ? (
          <>
            {" "}
            <span>
              {currentTrack.label}
            </span>{" "}
          </>
        ) : (
          "Loading radio…"
        )}
      </div>
    </section>
  );
};

