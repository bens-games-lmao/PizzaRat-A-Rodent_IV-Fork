#include "rodent.h"
#include <iostream>
#include <string>
#include <cstdlib>
#include <ctime>
#include <vector>
#include <fstream>
#include <unordered_map>
#include <cstring>

namespace {

enum TauntCategory {
    TAUNT_CAT_GENERAL,
    TAUNT_CAT_CAPTURE,
    TAUNT_CAT_USER_BLUNDER,
    TAUNT_CAT_ENGINE_BLUNDER,
    TAUNT_CAT_LOSING,
    TAUNT_CAT_WINNING,
    TAUNT_CAT_CRUSHING,
    TAUNT_CAT_ADVANTAGE,
    TAUNT_CAT_BALANCE,
    TAUNT_CAT_DISADVANTAGE,
    TAUNT_CAT_ESCAPE,
    TAUNT_CAT_GAINING,
    TAUNT_CAT_COUNT
};

// Simple tag bits to allow multi-dimensional taunt selection.
// Tags are optional; sections without tags are treated as neutral.
enum TauntTag {
    TAG_RUDE      = 1 << 0,
    TAG_POLITE    = 1 << 1,
    TAG_SELFDEP   = 1 << 2, // self-deprecating
    TAG_STREET    = 1 << 3  // street / hustler flavor
};

struct TauntEntry {
    std::string text;
    unsigned    tags; // combination of TauntTag bits
};

static std::vector<TauntEntry> s_taunts[TAUNT_CAT_COUNT];
static bool s_tauntsLoaded = false;
static std::string s_loadedConfigFile;

static void Trim(std::string &s) {
    const char *ws = " \t\r\n";
    std::string::size_type b = s.find_first_not_of(ws);
    if (b == std::string::npos) {
        s.clear();
        return;
    }
    std::string::size_type e = s.find_last_not_of(ws);
    s = s.substr(b, e - b + 1);
}

static TauntCategory CategoryFromName(const std::string &name) {
    static const std::unordered_map<std::string, TauntCategory> map = {
        { "GENERAL",        TAUNT_CAT_GENERAL },
        { "CAPTURE",        TAUNT_CAT_CAPTURE },
        { "USER_BLUNDER",   TAUNT_CAT_USER_BLUNDER },
        { "ENGINE_BLUNDER", TAUNT_CAT_ENGINE_BLUNDER },
        { "LOSING",         TAUNT_CAT_LOSING },
        { "WINNING",        TAUNT_CAT_WINNING },
        { "CRUSHING",       TAUNT_CAT_CRUSHING },
        { "ADVANTAGE",      TAUNT_CAT_ADVANTAGE },
        { "BALANCE",        TAUNT_CAT_BALANCE },
        { "DISADVANTAGE",   TAUNT_CAT_DISADVANTAGE },
        { "ESCAPE",         TAUNT_CAT_ESCAPE },
        { "GAINING",        TAUNT_CAT_GAINING },
    };

    auto it = map.find(name);
    if (it != map.end())
        return it->second;

    return TAUNT_CAT_GENERAL;
}

static unsigned TagFromName(const std::string &name) {

    // Tags are expected to be UPPERCASE ASCII in config, e.g. [WINNING;RUDE;STREET]
    if (name == "RUDE")      return TAG_RUDE;
    if (name == "POLITE")    return TAG_POLITE;
    if (name == "SELFDEP")   return TAG_SELFDEP;
    if (name == "STREET")    return TAG_STREET;

    return 0u;
}

static bool LoadTauntsFile(const char *fileName) {

    std::ifstream in(fileName);
    if (!in)
        return false;

    std::string line;
    TauntCategory current = TAUNT_CAT_GENERAL;
    unsigned currentTags = 0u;

    while (std::getline(in, line)) {

        Trim(line);
        if (line.empty())
            continue;

        const char ch = line[0];
        if (ch == '#' || ch == ';')
            continue;

        if (line.front() == '[' && line.back() == ']') {
            std::string section = line.substr(1, line.size() - 2);
            Trim(section);
            if (!section.empty()) {
                // Allow section headers of the form: CATEGORY or CATEGORY;TAG1;TAG2
                std::string::size_type pos = section.find(';');
                std::string base = (pos == std::string::npos) ? section : section.substr(0, pos);
                Trim(base);
                if (!base.empty())
                    current = CategoryFromName(base);

                currentTags = 0u;
                while (pos != std::string::npos) {
                    std::string::size_type next = section.find(';', pos + 1);
                    std::string tag = section.substr(pos + 1, next == std::string::npos ? std::string::npos : next - pos - 1);
                    Trim(tag);
                    if (!tag.empty())
                        currentTags |= TagFromName(tag);
                    pos = next;
                }
            }
            continue;
        }

        TauntEntry entry;
        entry.text = line;
        entry.tags = currentTags;
        s_taunts[current].push_back(entry);
    }

    return true;
}

static void EnsureTauntsLoaded() {
    // Reload only if we haven't loaded yet or the configured file name changed.
    if (s_tauntsLoaded && s_loadedConfigFile == Glob.tauntFile)
        return;

    // Clear existing taunts before re-loading.
    for (int i = 0; i < TAUNT_CAT_COUNT; ++i)
        s_taunts[i].clear();

    const char *requested = Glob.tauntFile.empty() ? "taunts.txt" : Glob.tauntFile.c_str();
    const char *used = requested;

    bool ok = LoadTauntsFile(requested);

    if (!ok && std::strcmp(requested, "taunts.txt") != 0) {
        // Fallback to default file name if custom file failed.
        ok = LoadTauntsFile("taunts.txt");
        used = "taunts.txt";
    }

    int total = 0;
    for (int i = 0; i < TAUNT_CAT_COUNT; ++i)
        total += static_cast<int>(s_taunts[i].size());

    if (Glob.isNoisy) {
        if (!ok || total == 0) {
            std::cout << "info string taunts: failed to load from '" << requested
                      << "', using '" << used << "' (" << total << " lines)" << std::endl;
        } else {
            std::cout << "info string taunts loaded from '" << used
                      << "' (" << total << " lines)" << std::endl;
        }
    }

    s_loadedConfigFile = Glob.tauntFile;
    s_tauntsLoaded = true;
}

static bool ShouldTauntNow(int eventType) {

    if (!Glob.useTaunting)
        return false;

    if (Glob.tauntIntensity <= 0)
        return false;

    // If we are in a clearly worse state, optionally dial down taunts
    bool losingEvent = (eventType == TAUNT_DISADVANTAGE ||
                        eventType == TAUNT_LOSING);

    if (losingEvent && Glob.tauntWhenLosing < 100) {
        if ((std::rand() % 100) >= Glob.tauntWhenLosing)
            return false;
    }

    if (Glob.tauntIntensity >= 100)
        return true;

    return (std::rand() % 100) < Glob.tauntIntensity;
}

static bool PassRudenessFilter(const TauntEntry &e) {

    // If no rudeness-related tags, always allowed.
    const unsigned rudeMask = TAG_RUDE | TAG_POLITE;
    if ((e.tags & rudeMask) == 0)
        return true;

    int r = Glob.tauntRudeness;

    // Low rudeness: avoid explicitly RUDE lines when possible.
    if (r <= 33 && (e.tags & TAG_RUDE))
        return false;

    // High rudeness: avoid explicitly POLITE lines when possible.
    if (r >= 67 && (e.tags & TAG_POLITE))
        return false;

    // Mid-range or neutral: accept both.
    return true;
}

static void PrintRandomTaunt(TauntCategory cat) {

    std::vector<TauntEntry> &v = s_taunts[cat];

    if (v.empty())
        return;

    // First try to build a filtered list according to rudeness.
    std::vector<int> candidates;
    candidates.reserve(v.size());

    for (int i = 0; i < (int)v.size(); ++i) {
        if (PassRudenessFilter(v[i]))
            candidates.push_back(i);
    }

    const TauntEntry *chosen = nullptr;

    if (!candidates.empty()) {
        int idx = candidates[std::rand() % candidates.size()];
        chosen = &v[idx];
    } else {
        // If filter removed everything, fall back to the full list.
        const int idx = std::rand() % v.size();
        chosen = &v[idx];
    }

    std::cout << "info string " << chosen->text << std::endl;
}

} // namespace

// 

void PrintTaunt(int eventType) {

    EnsureTauntsLoaded();

    if (!ShouldTauntNow(eventType))
        return;

    Glob.currentTaunt = eventType;

    if (Glob.previousValue == 8888) {
        PrintGenericTaunt();
        return;
    }

    if (Glob.previousValue != 8888) {
        int delta = Glob.gameValue - Glob.previousValue;

        bool isSmallGain = delta > 30 && delta < 60;

        if (delta > 200) {
            PrintUserBlunderTaunt();
            return;
        }

        if (delta < -200) {
            PrintEngineBlunderTaunt();
            return;
        }

        if (isSmallGain && eventType == TAUNT_BALANCE) {
            PrintEngineEscapeTaunt();
            return;
        }

        if (isSmallGain && eventType == TAUNT_ADVANTAGE) {
            PrintGainingTaunt();
            return;
        }
    }

    if (eventType == TAUNT_CAPTURE)
        PrintCaptureTaunt();
    else if (eventType == TAUNT_WINNING)
        PrintWinningTaunt();
    else if (eventType == TAUNT_ADVANTAGE)
        PrintAdvantageTaunt();
    else if (eventType == TAUNT_BALANCE)
        PrintBalanceTaunt();
    else if (eventType == TAUNT_DISADVANTAGE)
        PrintDisdvantageTaunt();
    else if (eventType == TAUNT_LOSING)
        PrintLosingTaunt();
    else if (eventType == TAUNT_CRUSHING)
        PrintCrushingTaunt();
    else
        PrintGenericTaunt();
}


void PrintGenericTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_GENERAL);
}

void PrintCaptureTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_CAPTURE);
}

void PrintWinningTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_WINNING);
}

void PrintAdvantageTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_ADVANTAGE);
}

void PrintBalanceTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_BALANCE);
}

void PrintDisdvantageTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_DISADVANTAGE);
}

void PrintLosingTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_LOSING);
}

void PrintCrushingTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_CRUSHING);
}

void PrintUserBlunderTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_USER_BLUNDER);
}

void PrintEngineBlunderTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_ENGINE_BLUNDER);
}

void PrintEngineEscapeTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_ESCAPE);
}

void PrintGainingTaunt() {
    EnsureTauntsLoaded();
    PrintRandomTaunt(TAUNT_CAT_GAINING);
}