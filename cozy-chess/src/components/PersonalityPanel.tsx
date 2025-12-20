import React, { useEffect, useState } from "react";
import { cozyApi, type CharacterSummary, type CharacterProfile } from "../cozyApi";

export interface SessionCharacterProfile extends CharacterProfile {}

interface PersonalityPanelProps {
  sessionProfile: SessionCharacterProfile | null;
  onSessionProfileChange: (profile: SessionCharacterProfile | null) => void;
  onApplyProfile: (profile: SessionCharacterProfile | null) => void;
}

export const PersonalityPanel: React.FC<PersonalityPanelProps> = ({
  sessionProfile,
  onSessionProfileChange,
  onApplyProfile
}) => {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    cozyApi
      .listCharacters()
      .then((list) => {
        if (!cancelled) {
          setCharacters(list);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSelectCharacter(id: string) {
    if (!id) {
      onSessionProfileChange(null);
      return;
    }
    try {
      const profile = await cozyApi.getCharacter(id);
      onSessionProfileChange(profile);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to load character:", err);
    }
  }

  function updateStrength<K extends keyof NonNullable<SessionCharacterProfile["strength"]>>(
    key: K,
    value: NonNullable<SessionCharacterProfile["strength"]>[K]
  ) {
    if (!sessionProfile) return;
    onSessionProfileChange({
      ...sessionProfile,
      strength: {
        ...sessionProfile.strength,
        [key]: value
      }
    });
  }

  function updateTime<K extends keyof NonNullable<SessionCharacterProfile["time"]>>(
    key: K,
    value: NonNullable<SessionCharacterProfile["time"]>[K]
  ) {
    if (!sessionProfile) return;
    onSessionProfileChange({
      ...sessionProfile,
      time: {
        ...sessionProfile.time,
        [key]: value
      }
    });
  }

  const currentElo =
    sessionProfile && sessionProfile.strength && typeof sessionProfile.strength.targetElo === "number"
      ? sessionProfile.strength.targetElo
      : 1800;

  return (
    <section>


      <div className="cozy-section">
        <div className="cozy-row">

          <select
            id="cozy-character-select"
            className="cozy-select"
            disabled={loading}
            value={sessionProfile?.id ?? ""}
            onChange={(e) => handleSelectCharacter(e.target.value)}
          >
            <option value="">Select Opponent</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} {typeof c.elo === "number" ? `(${c.elo})` : ""}
              </option>
            ))}
          </select>
        </div>

        {sessionProfile && (
          <>
            <div className="cozy-row" style={{ marginTop: "0.6rem" }}>
              <label className="cozy-label" htmlFor="cozy-elo-slider">
                <span>Strength</span>
                <span className="cozy-label-sub">{currentElo} Elo target</span>
              </label>
              <input
                id="cozy-elo-slider"
                className="cozy-slider"
                type="range"
                min={800}
                max={2600}
                step={50}
                value={currentElo}
                onChange={(e) => updateStrength("targetElo", Number(e.target.value))}
              />
            </div>

            <div className="cozy-row">
              <label className="cozy-label" htmlFor="cozy-nervous-slider">
                <span>Time pressure</span>
                <span className="cozy-label-sub">How frantic the engine plays under time.</span>
              </label>
              <input
                id="cozy-nervous-slider"
                className="cozy-slider"
                type="range"
                min={0}
                max={100}
                value={sessionProfile.time?.timeNervousness ?? 50}
                onChange={(e) => updateTime("timeNervousness", Number(e.target.value))}
              />
            </div>

            <div className="cozy-row" style={{ marginTop: "0.6rem" }}>
              <button
                type="button"
                className="cozy-btn"
                onClick={() => onApplyProfile(sessionProfile)}
              >
                Apply &amp; start game
              </button>
              <button
                type="button"
                className="cozy-btn secondary"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                {advancedOpen ? "Hide advanced knobs" : "Show advanced knobs"}
              </button>
            </div>
          </>
        )}
      </div>

      {advancedOpen && sessionProfile && (
        <div className="cozy-section">
          <h3 className="cozy-card-title">Advanced strength</h3>
          <p className="cozy-card-subtitle">
            These map directly to Rodent IV options for search skill, selectivity, and time usage.
          </p>

          <div className="cozy-row">
            <label className="cozy-label" htmlFor="cozy-search-skill">
              <span>Search skill</span>
            </label>
            <input
              id="cozy-search-skill"
              className="cozy-input"
              type="number"
              value={sessionProfile.strength?.searchSkill ?? ""}
              onChange={(e) =>
                updateStrength(
                  "searchSkill",
                  e.target.value === "" ? undefined : Number(e.target.value)
                )
              }
            />
          </div>

          <div className="cozy-row">
            <label className="cozy-label" htmlFor="cozy-selectivity">
              <span>Selectivity</span>
            </label>
            <input
              id="cozy-selectivity"
              className="cozy-input"
              type="number"
              value={sessionProfile.strength?.selectivity ?? ""}
              onChange={(e) =>
                updateStrength(
                  "selectivity",
                  e.target.value === "" ? undefined : Number(e.target.value)
                )
              }
            />
          </div>

          <div className="cozy-row">
            <label className="cozy-label" htmlFor="cozy-slowmover">
              <span>Slow mover</span>
            </label>
            <input
              id="cozy-slowmover"
              className="cozy-input"
              type="number"
              value={sessionProfile.strength?.slowMover ?? ""}
              onChange={(e) =>
                updateStrength(
                  "slowMover",
                  e.target.value === "" ? undefined : Number(e.target.value)
                )
              }
            />
          </div>
        </div>
      )}
    </section>
  );
};


