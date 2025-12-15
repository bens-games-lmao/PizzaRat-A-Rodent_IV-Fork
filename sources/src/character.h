/*
Rodent, a UCI chess playing engine derived from Sungorus 1.4
Copyright (C) 2009-2011 Pablo Vazquez (Sungorus author)
Copyright (C) 2011-2019 Pawel Koziol

This file is part of the character / personality refactor layer.
*/

#pragma once

#include <string>

// Forward declarations to avoid heavy header dependencies.
class cParam;
class cGlobals;
struct sBook;

// High-level description of a book policy for a character.
struct CharacterBooks {
    std::string guideBookFile;  // empty => keep current
    std::string mainBookFile;   // empty => keep current
    int maxGuideBookPly;        // -1 => unlimited
    int maxMainBookPly;         // -1 => unlimited
    int bookFilter;             // percentage, 0 => keep Par.bookFilter

    CharacterBooks()
        : maxGuideBookPly(-1)
        , maxMainBookPly(-1)
        , bookFilter(0) {}
};

// High-level description of strength / weakening.
struct CharacterStrength {
    int targetElo;
    bool useWeakening;
    int searchSkill;
    int selectivity;    // maps to Par.hist_perc
    int slowMover;      // maps to Par.timePercentage
    int minElo;
    int maxElo;

    CharacterStrength()
        : targetElo(2800)
        , useWeakening(true)
        , searchSkill(10)
        , selectivity(175)
        , slowMover(100)
        , minElo(800)
        , maxElo(2800) {}
};

// Time usage / hustle configuration for a character.
struct CharacterTimeUsage {
    int timePercentage;   // duplicate of slowMover for clarity (0..500)
    int timeNervousness;  // 0..100, like Glob.timeNervousness
    int blitzHustle;      // 0..100, like Glob.blitzHustle
    int minThinkTimePercent; // 0..200, percentage of budget to enforce as visible delay

    CharacterTimeUsage()
        : timePercentage(100)
        , timeNervousness(50)
        , blitzHustle(50)
        , minThinkTimePercent(100) {}
};

// Taunt / chatter configuration snapshot.
struct CharacterTaunts {
    bool        tauntingEnabled;
    std::string tauntFile;
    int         tauntIntensity;
    int         tauntRudeness;
    int         tauntWhenLosing;
    int         tauntUserBlunderDelta;
    int         tauntEngineBlunderDelta;
    int         tauntSmallGainMin;
    int         tauntSmallGainMax;
    int         tauntBalanceWindow;
    int         tauntAdvantageThreshold;
    int         tauntWinningThreshold;
    int         tauntCrushingThreshold;

    CharacterTaunts()
        : tauntingEnabled(false)
        , tauntIntensity(100)
        , tauntRudeness(50)
        , tauntWhenLosing(50)
        , tauntUserBlunderDelta(200)
        , tauntEngineBlunderDelta(200)
        , tauntSmallGainMin(30)
        , tauntSmallGainMax(60)
        , tauntBalanceWindow(15)
        , tauntAdvantageThreshold(50)
        , tauntWinningThreshold(100)
        , tauntCrushingThreshold(300) {}
};

// Top-level character profile that we can dump, tweak and (gradually) use
// as the single source of truth for a personality.
struct CharacterProfile {
    std::string      id;
    std::string      description;
    CharacterStrength strength;
    CharacterBooks    books;
    CharacterTimeUsage timeUsage;
    CharacterTaunts    taunts;
};

// Global active character profile (one at a time, like Par/Glob).
extern CharacterProfile ActiveCharacter;

// Initialize a profile with generic defaults roughly matching current engine defaults.
void InitDefaultCharacterProfile(CharacterProfile &profile);

// Take a snapshot of the current engine configuration and store it in the profile.
void SnapshotFromEngineToCharacterProfile(CharacterProfile &profile,
                                          const cParam   &Par,
                                          const cGlobals &Glob,
                                          const sBook    &guideBook,
                                          const sBook    &mainBook);

// Apply a profile back onto the engine configuration. This is intended to be used
// after reading a personality, or when selecting a character by name.
void ApplyCharacterProfile(const CharacterProfile &profile,
                           cParam   &Par,
                           cGlobals &Glob,
                           sBook    &guideBook,
                           sBook    &mainBook);

// Debug helper for dumping the active character sheet.
void DumpCharacterProfile(const CharacterProfile &profile);

// JSON dump helper for tooling / web UI.
void DumpCharacterJson(const CharacterProfile &profile);


