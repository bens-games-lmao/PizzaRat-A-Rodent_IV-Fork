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

static std::vector<std::string> s_taunts[TAUNT_CAT_COUNT];
static bool s_tauntsLoaded = false;

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

static bool LoadTauntsFile(const char *fileName) {

    std::ifstream in(fileName);
    if (!in)
        return false;

    std::string line;
    TauntCategory current = TAUNT_CAT_GENERAL;

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
            if (!section.empty())
                current = CategoryFromName(section);
            continue;
        }

        s_taunts[current].push_back(line);
    }

    return true;
}

static void EnsureTauntsLoaded() {
    if (s_tauntsLoaded)
        return;

    std::srand(static_cast<unsigned int>(std::time(nullptr)));

    const char *fileName = Glob.tauntFile.empty() ? "taunts.txt" : Glob.tauntFile.c_str();
    if (!LoadTauntsFile(fileName)) {
        // fallback to default name if custom file failed
        if (std::strcmp(fileName, "taunts.txt") != 0)
            LoadTauntsFile("taunts.txt");
    }

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

static void PrintRandomTaunt(TauntCategory cat) {

    std::vector<std::string> &v = s_taunts[cat];

    if (v.empty())
        return;

    const std::string &word = v[std::rand() % v.size()];
    std::cout << "info string " << word << std::endl;
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