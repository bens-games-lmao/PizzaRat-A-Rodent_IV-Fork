// Web-based management dashboard for canonical CharacterProfile JSON
// stored in characters/*.json and served via the character manager API.

function $(id) {
    return document.getElementById(id);
}

const state = {
    character: null,
    characters: [],
    selectedId: null,
    apiAvailable: false,
    dirty: false,
};

const API_BASE = "/api";

function renderCharacter() {
    const view = $("characterView");
    const c = state.character;

    if (!state.apiAvailable) {
        view.innerHTML = "<p class=\"panel-text\"> </p>";
        return;
    }

    if (!c) {
        view.innerHTML = "<p class=\"panel-text\">No character loaded yet.</p>";
        return;
    }

    const strength = c.strength || {};
    const books = c.books || {};
    const time = c.time || {};
    const taunts = c.taunts || {};

    view.innerHTML = `
<article class="card">
  <!--<div class="portrait">
    <div class="portrait-label">Character</div>
  </div>-->
  <div class="card-body">
    <h2 class="name">${escapeHtml(c.id || "(unnamed)")}</h2>
    <p class="role">${escapeHtml(c.description || "")}</p>

    <p class="elo">Strength</p>
    <ul class="traits">
      <li><strong>Elo:</strong>
        <input id="eloInput" type="number" value="${strength.targetElo ?? ""}" />
      </li>
      <li><strong>Use weakening:</strong>
        <input id="weakeningInput" type="checkbox" ${strength.useWeakening ? "checked" : ""} />
      </li>
      <li><strong>Search skill:</strong>
        <input id="skillInput" type="number" value="${strength.searchSkill ?? ""}" />
      </li>
      <li><strong>Selectivity:</strong>
        <input id="selectivityInput" type="number" value="${strength.selectivity ?? ""}" />
      </li>
      <li><strong>SlowMover:</strong>
        <input id="slowMoverInput" type="number" value="${strength.slowMover ?? ""}" />
      </li>
    </ul>

    <p class="elo">Books</p>
    <ul class="traits">
      <li><strong>GuideBookFile:</strong>
        <input id="guideBookInput" type="text" value="${escapeHtml(books.guideBookFile || "")}" />
      </li>
      <li><strong>MainBookFile:</strong>
        <input id="mainBookInput" type="text" value="${escapeHtml(books.mainBookFile || "")}" />
      </li>
      <li><strong>MaxMainBookPly:</strong>
        <input id="maxMainBookPlyInput" type="number" value="${books.maxMainBookPly ?? -1}" />
      </li>
      <li><strong>BookFilter:</strong>
        <input id="bookFilterInput" type="number" value="${books.bookFilter ?? 20}" />
      </li>
    </ul>

    <p class="elo">Time</p>
    <ul class="traits">
      <li><strong>TimePercentage (SlowMover):</strong>
        <input id="timePercentInput" type="number" value="${time.timePercentage ?? strength.slowMover ?? 100}" />
      </li>
      <li><strong>TimeNervousness:</strong>
        <input id="nervousInput" type="number" value="${time.timeNervousness ?? 50}" />
      </li>
      <li><strong>BlitzHustle:</strong>
        <input id="hustleInput" type="number" value="${time.blitzHustle ?? 50}" />
      </li>
      <li><strong>MinThinkTimePercent:</strong>
        <input id="minThinkInput" type="number" value="${time.minThinkTimePercent ?? 100}" />
      </li>
    </ul>

    <p class="elo">Taunts</p>
    <ul class="traits">
      <li><strong>Enabled:</strong>
        <input id="tauntEnabledInput" type="checkbox" ${taunts.enabled ? "checked" : ""} />
      </li>
      <li><strong>TauntFile:</strong>
        <input id="tauntFileInput" type="text" value="${escapeHtml(taunts.tauntFile || "")}" />
      </li>
      <li><strong>Intensity:</strong>
        <input id="tauntIntensityInput" type="number" value="${taunts.intensity ?? 100}" />
      </li>
      <li><strong>Rudeness:</strong>
        <input id="tauntRudenessInput" type="number" value="${taunts.rudeness ?? 50}" />
      </li>
    </ul>
  </div>
</article>`;

    // hook change events to keep state in sync
    attachInputs();
}

function attachInputs() {
    if (!state.character) return;
    const c = state.character;

    function markDirty() {
        state.dirty = true;
        renderScript();
        updateSaveButtons();
    }

    function num(id, obj, key) {
        const el = $(id);
        if (!el) return;
        el.addEventListener("input", () => {
            const v = parseInt(el.value, 10);
            if (!isNaN(v)) obj[key] = v;
            markDirty();
        });
    }

    function txt(id, obj, key) {
        const el = $(id);
        if (!el) return;
        el.addEventListener("input", () => {
            obj[key] = el.value;
            markDirty();
        });
    }

    function bool(id, obj, key) {
        const el = $(id);
        if (!el) return;
        el.addEventListener("change", () => {
            obj[key] = !!el.checked;
            markDirty();
        });
    }

    const s = c.strength || (c.strength = {});
    const b = c.books || (c.books = {});
    const t = c.time || (c.time = {});
    const ta = c.taunts || (c.taunts = {});

    num("eloInput", s, "targetElo");
    bool("weakeningInput", s, "useWeakening");
    num("skillInput", s, "searchSkill");
    num("selectivityInput", s, "selectivity");
    num("slowMoverInput", s, "slowMover");

    txt("guideBookInput", b, "guideBookFile");
    txt("mainBookInput", b, "mainBookFile");
    num("maxMainBookPlyInput", b, "maxMainBookPly");
    num("bookFilterInput", b, "bookFilter");

    num("timePercentInput", t, "timePercentage");
    num("nervousInput", t, "timeNervousness");
    num("hustleInput", t, "blitzHustle");
    num("minThinkInput", t, "minThinkTimePercent");

    bool("tauntEnabledInput", ta, "enabled");
    txt("tauntFileInput", ta, "tauntFile");
    num("tauntIntensityInput", ta, "intensity");
    num("tauntRudenessInput", ta, "rudeness");
}

function renderScript() {
    // Textual setoption exports are intentionally omitted in the
    // production dashboard; JSON in characters/*.json is the source
    // of truth and .txt exports are handled server-side.
}

function setApiStatus(message, isError) {
    const el = $("apiStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "#fecaca" : "#9ca3af";
}

function updateSaveButtons() {
    const hasSelection = !!state.selectedId;
    const saveBtn = $("saveCharacter");
    const copyBtn = $("copyCharacter");
    const deleteBtn = $("deleteCharacter");
    const exportBtn = $("exportCharacter");

    if (saveBtn) saveBtn.disabled = !hasSelection || !state.dirty;
    if (copyBtn) copyBtn.disabled = !hasSelection;
    if (deleteBtn) deleteBtn.disabled = !hasSelection;
    if (exportBtn) exportBtn.disabled = !hasSelection;
}

function renderCharacterList() {
    const listEl = $("characterList");
    if (!listEl) return;

    const chars = state.characters || [];
    if (!chars.length) {
        listEl.innerHTML = '<li class="character-list-item"><span class="character-name">(no characters yet)</span></li>';
        return;
    }

    listEl.innerHTML = "";
    chars.forEach((ch) => {
        const li = document.createElement("li");
        li.className = "character-list-item" + (ch.id === state.selectedId ? " active" : "");

        const nameSpan = document.createElement("span");
        nameSpan.className = "character-name";
        nameSpan.textContent = ch.id;

        const metaSpan = document.createElement("span");
        metaSpan.className = "character-meta";
        const bits = [];
        if (typeof ch.elo === "number") bits.push(ch.elo);
        if (ch.description) bits.push(ch.description);
        metaSpan.textContent = bits.join(" · ");

        li.appendChild(nameSpan);
        li.appendChild(metaSpan);

        li.addEventListener("click", () => {
            if (state.selectedId === ch.id && !state.dirty) {
                return;
            }
            if (state.dirty && state.selectedId && !confirm("Discard unsaved changes to the current character?")) {
                return;
            }
            loadCharacterFromApi(ch.id);
        });

        listEl.appendChild(li);
    });
}

function fetchCharactersFromApi() {
    return fetch(API_BASE + "/characters")
        .then((res) => {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        })
        .then((list) => {
            state.characters = Array.isArray(list) ? list : [];
            state.apiAvailable = true;
            setApiStatus("Connected to character manager API.", false);
            renderCharacterList();
        })
        .catch((err) => {
            console.error(err);
            state.apiAvailable = false;
            state.characters = [];
            setApiStatus(
                "Character API not reachable. Start the manager service (tools/character-manager). The editor cannot operate without it.",
                true
            );
            state.character = null;
            state.selectedId = null;
            renderCharacterList();
            renderCharacter();
        })
        .finally(() => {
            updateSaveButtons();
        });
}

function loadCharacterFromApi(id) {
    const safeId = id;
    return fetch(API_BASE + "/characters/" + encodeURIComponent(safeId))
        .then((res) => {
            if (res.status === 404) {
                throw new Error("Character not found: " + safeId);
            }
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        })
        .then((data) => {
            state.character = data;
            state.selectedId = data.id || safeId;
            state.dirty = false;
            renderCharacter();
            renderScript();
            renderCharacterList();
            updateSaveButtons();
        })
        .catch((err) => {
            alert(err.message || String(err));
        });
}

function saveSelectedCharacter() {
    if (!state.selectedId || !state.character) return;
    const id = state.selectedId;

    fetch(API_BASE + "/characters/" + encodeURIComponent(id), {
        method: "PUT",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(state.character)
    })
        .then((res) => {
            if (!res.ok) return res.json().then((j) => { throw new Error(j.error || ("HTTP " + res.status)); });
            return res.json();
        })
        .then((data) => {
            state.character = data;
            state.selectedId = data.id || id;
            state.dirty = false;
            setApiStatus("Character saved.", false);
            // refresh list metadata (elo/description)
            const idx = state.characters.findIndex((c) => c.id === state.selectedId);
            if (idx >= 0) {
                state.characters[idx].description = data.description || "";
                state.characters[idx].elo = data.strength && typeof data.strength.targetElo === "number"
                    ? data.strength.targetElo
                    : state.characters[idx].elo;
            }
            renderCharacterList();
            updateSaveButtons();
        })
        .catch((err) => {
            alert(err.message || String(err));
        });
}

function createNewCharacter() {
    if (!state.apiAvailable) {
        alert("Character API not available. Start the manager service first.");
        return;
    }
    if (state.dirty && state.selectedId && !confirm("Discard unsaved changes to the current character?")) {
        return;
    }

    fetch(API_BASE + "/characters", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({})
    })
        .then((res) => {
            if (!res.ok) return res.json().then((j) => { throw new Error(j.error || ("HTTP " + res.status)); });
            return res.json();
        })
        .then((data) => {
            state.character = data;
            state.selectedId = data.id;
            state.dirty = false;
            setApiStatus("New character created.", false);
            // update list
            state.characters.push({
                id: data.id,
                description: data.description || "",
                elo: data.strength && typeof data.strength.targetElo === "number"
                    ? data.strength.targetElo
                    : null
            });
            renderCharacter();
            renderScript();
            renderCharacterList();
            updateSaveButtons();
        })
        .catch((err) => {
            alert(err.message || String(err));
        });
}

function copySelectedCharacter() {
    if (!state.selectedId) return;

    fetch(API_BASE + "/characters/" + encodeURIComponent(state.selectedId) + "/copy", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({})
    })
        .then((res) => {
            if (!res.ok) return res.json().then((j) => { throw new Error(j.error || ("HTTP " + res.status)); });
            return res.json();
        })
        .then((data) => {
            state.character = data;
            state.selectedId = data.id;
            state.dirty = false;
            setApiStatus("Character duplicated.", false);
            state.characters.push({
                id: data.id,
                description: data.description || "",
                elo: data.strength && typeof data.strength.targetElo === "number"
                    ? data.strength.targetElo
                    : null
            });
            renderCharacter();
            renderScript();
            renderCharacterList();
            updateSaveButtons();
        })
        .catch((err) => {
            alert(err.message || String(err));
        });
}

function deleteSelectedCharacter() {
    if (!state.selectedId) return;
    if (!confirm("Delete character '" + state.selectedId + "'? This cannot be undone.")) {
        return;
    }

    fetch(API_BASE + "/characters/" + encodeURIComponent(state.selectedId), {
        method: "DELETE"
    })
        .then((res) => {
            if (res.status === 204) return;
            if (!res.ok) return res.json().then((j) => { throw new Error(j.error || ("HTTP " + res.status)); });
        })
        .then(() => {
            const id = state.selectedId;
            state.characters = state.characters.filter((c) => c.id !== id);
            state.character = null;
            state.selectedId = null;
            state.dirty = false;
            setApiStatus("Character deleted.", false);
            renderCharacter();
            renderScript();
            renderCharacterList();
            updateSaveButtons();
        })
        .catch((err) => {
            alert(err.message || String(err));
        });
}

function exportSelectedCharacter() {
    if (!state.selectedId) return;

    fetch(API_BASE + "/characters/" + encodeURIComponent(state.selectedId) + "/export-txt", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({})
    })
        .then((res) => {
            if (!res.ok) return res.json().then((j) => { throw new Error(j.error || ("HTTP " + res.status)); });
            return res.json();
        })
        .then((data) => {
            const file = data && data.personalityFile ? data.personalityFile : "(unknown)";
            alert("Exported legacy personality file: " + file);
        })
        .catch((err) => {
            alert(err.message || String(err));
        });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function setupDropzone() {
    // Offline file-drop / inspector mode is intentionally disabled
    // for the production dashboard; the tool only operates when the
    // character manager API is available.
}

function setupButtons() {
    const refreshBtn = $("refreshCharacters");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
            fetchCharactersFromApi();
        });
    }

    const newBtn = $("newCharacter");
    if (newBtn) {
        newBtn.addEventListener("click", () => {
            createNewCharacter();
        });
    }

    const saveBtn = $("saveCharacter");
    if (saveBtn) {
        saveBtn.addEventListener("click", () => {
            saveSelectedCharacter();
        });
    }

    const copyCharBtn = $("copyCharacter");
    if (copyCharBtn) {
        copyCharBtn.addEventListener("click", () => {
            copySelectedCharacter();
        });
    }

    const deleteBtn = $("deleteCharacter");
    if (deleteBtn) {
        deleteBtn.addEventListener("click", () => {
            deleteSelectedCharacter();
        });
    }

    const exportBtn = $("exportCharacter");
    if (exportBtn) {
        exportBtn.addEventListener("click", () => {
            exportSelectedCharacter();
        });
    }
}

window.addEventListener("DOMContentLoaded", () => {
    setupDropzone();
    setupButtons();
    fetchCharactersFromApi();
    renderCharacter();
    renderScript();
    updateSaveButtons();
});


