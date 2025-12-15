/*
Rodent, a UCI chess playing engine derived from Sungorus 1.4
Copyright (C) 2009-2011 Pablo Vazquez (Sungorus author)
Copyright (C) 2011-2019 Pawel Koziol

Character / personality helper layer.
This file introduces a high-level CharacterProfile abstraction and helpers
to synchronise it with existing engine configuration (Par, Glob, books).
*/

#include "rodent.h"
#include "book.h"
#include "character.h"

CharacterProfile ActiveCharacter;

void InitDefaultCharacterProfile(CharacterProfile &profile) {

    profile.id          = "default";
    profile.description = "Default Rodent IV character profile";

    // Strength defaults roughly match current engine defaults.
    profile.strength.targetElo    = 2800;
    profile.strength.useWeakening = true;
    profile.strength.searchSkill  = 10;
    profile.strength.selectivity  = 175;
    profile.strength.slowMover    = 100;
    profile.strength.minElo       = 800;
    profile.strength.maxElo       = 2800;

    // Books: we leave file names empty here; they will be filled from engine
    // state (GuideBook/MainBook) once those are initialised.
    profile.books.maxGuideBookPly = -1;
    profile.books.maxMainBookPly  = -1;
    profile.books.bookFilter      = 0;

    // Time usage defaults.
    profile.timeUsage.timePercentage  = 100;
    profile.timeUsage.timeNervousness = 50;
    profile.timeUsage.blitzHustle     = 50;

    // Taunt defaults roughly mirror InitPizzaratDefaults().
    profile.taunts.tauntingEnabled        = true;
    profile.taunts.tauntFile              = "taunts.txt";
    profile.taunts.tauntIntensity         = 100;
    profile.taunts.tauntRudeness          = 50;
    profile.taunts.tauntWhenLosing        = 50;
    profile.taunts.tauntUserBlunderDelta  = 200;
    profile.taunts.tauntEngineBlunderDelta= 200;
    profile.taunts.tauntSmallGainMin      = 30;
    profile.taunts.tauntSmallGainMax      = 60;
    profile.taunts.tauntBalanceWindow     = 15;
    profile.taunts.tauntAdvantageThreshold= 50;
    profile.taunts.tauntWinningThreshold  = 100;
    profile.taunts.tauntCrushingThreshold = 300;
}

void SnapshotFromEngineToCharacterProfile(CharacterProfile &profile,
                                          const cParam   &Par,
                                          const cGlobals &Glob,
                                          const sBook    &guideBook,
                                          const sBook    &mainBook) {

    // Identity is preserved unless explicitly changed.

    // Strength snapshot
    profile.strength.targetElo    = Par.elo;
    profile.strength.useWeakening = Par.useWeakening;
    profile.strength.searchSkill  = Par.searchSkill;
    profile.strength.selectivity  = Par.hist_perc;
    profile.strength.slowMover    = Par.timePercentage;

    // Books snapshot
    profile.books.guideBookFile = guideBook.bookName;
    profile.books.mainBookFile  = mainBook.bookName;
    profile.books.maxMainBookPly  = Par.bookDepth;
    // Currently guide-book depth follows the same limit; kept explicit for future tuning.
    profile.books.maxGuideBookPly = Par.bookDepth;
    profile.books.bookFilter      = Par.bookFilter;

    // Time usage
    profile.timeUsage.timePercentage      = Par.timePercentage;
    profile.timeUsage.timeNervousness     = Glob.timeNervousness;
    profile.timeUsage.blitzHustle         = Glob.blitzHustle;
    // minThinkTimePercent is a purely high-level knob, not present in
    // current engine configuration, so we leave whatever value it had
    // (typically the default 100) untouched here.

    // Taunts
    profile.taunts.tauntingEnabled         = Glob.useTaunting;
    profile.taunts.tauntFile               = Glob.tauntFile;
    profile.taunts.tauntIntensity          = Glob.tauntIntensity;
    profile.taunts.tauntRudeness           = Glob.tauntRudeness;
    profile.taunts.tauntWhenLosing         = Glob.tauntWhenLosing;
    profile.taunts.tauntUserBlunderDelta   = Glob.tauntUserBlunderDelta;
    profile.taunts.tauntEngineBlunderDelta = Glob.tauntEngineBlunderDelta;
    profile.taunts.tauntSmallGainMin       = Glob.tauntSmallGainMin;
    profile.taunts.tauntSmallGainMax       = Glob.tauntSmallGainMax;
    profile.taunts.tauntBalanceWindow      = Glob.tauntBalanceWindow;
    profile.taunts.tauntAdvantageThreshold = Glob.tauntAdvantageThreshold;
    profile.taunts.tauntWinningThreshold   = Glob.tauntWinningThreshold;
    profile.taunts.tauntCrushingThreshold  = Glob.tauntCrushingThreshold;
}

void ApplyCharacterProfile(const CharacterProfile &profile,
                           cParam   &Par,
                           cGlobals &Glob,
                           sBook    &guideBook,
                           sBook    &mainBook) {

    // --- Strength / weakening ---

    int elo = profile.strength.targetElo;
    if (profile.strength.minElo <= profile.strength.maxElo) {
        if (elo < profile.strength.minElo) elo = profile.strength.minElo;
        if (elo > profile.strength.maxElo) elo = profile.strength.maxElo;
    }

    Par.elo          = elo;
    Par.useWeakening = profile.strength.useWeakening;
    Par.searchSkill  = profile.strength.searchSkill;
    Par.hist_perc    = profile.strength.selectivity;
    Par.timePercentage = profile.strength.slowMover;

    // Recalculate weakening parameters (npsLimit, evalBlur, bookDepth) based on Elo.
    Par.SetSpeed(Par.elo);

    // --- Books ---

    if (!profile.books.guideBookFile.empty())
        guideBook.SetBookName(profile.books.guideBookFile.c_str());
    if (!profile.books.mainBookFile.empty())
        mainBook.SetBookName(profile.books.mainBookFile.c_str());

    if (profile.books.bookFilter > 0)
        Par.bookFilter = profile.books.bookFilter;

    if (profile.books.maxMainBookPly >= 0)
        Par.bookDepth = profile.books.maxMainBookPly;

    // Guide-book depth currently follows main-book depth; kept here for clarity.

    // --- Time usage ---

    Par.timePercentage   = profile.timeUsage.timePercentage;
    Glob.timeNervousness = profile.timeUsage.timeNervousness;
    Glob.blitzHustle     = profile.timeUsage.blitzHustle;

    // --- Taunts ---

    Glob.useTaunting          = profile.taunts.tauntingEnabled;
    Glob.tauntFile            = profile.taunts.tauntFile;
    Glob.tauntIntensity       = profile.taunts.tauntIntensity;
    Glob.tauntRudeness        = profile.taunts.tauntRudeness;
    Glob.tauntWhenLosing      = profile.taunts.tauntWhenLosing;
    Glob.tauntUserBlunderDelta   = profile.taunts.tauntUserBlunderDelta;
    Glob.tauntEngineBlunderDelta = profile.taunts.tauntEngineBlunderDelta;
    Glob.tauntSmallGainMin       = profile.taunts.tauntSmallGainMin;
    Glob.tauntSmallGainMax       = profile.taunts.tauntSmallGainMax;
    Glob.tauntBalanceWindow      = profile.taunts.tauntBalanceWindow;
    Glob.tauntAdvantageThreshold = profile.taunts.tauntAdvantageThreshold;
    Glob.tauntWinningThreshold   = profile.taunts.tauntWinningThreshold;
    Glob.tauntCrushingThreshold  = profile.taunts.tauntCrushingThreshold;
}

void DumpCharacterProfile(const CharacterProfile &profile) {

    printf("info string CHARACTER id='%s' elo=%d weaken=%s\n",
           profile.id.c_str(),
           profile.strength.targetElo,
           profile.strength.useWeakening ? "true" : "false");

    printf("info string CHARACTER books guide='%s' main='%s' maxGuidePly=%d maxMainPly=%d filter=%d\n",
           profile.books.guideBookFile.c_str(),
           profile.books.mainBookFile.c_str(),
           profile.books.maxGuideBookPly,
           profile.books.maxMainBookPly,
           profile.books.bookFilter);

    printf("info string CHARACTER time slowMover=%d nervousness=%d hustle=%d\n",
           profile.timeUsage.timePercentage,
           profile.timeUsage.timeNervousness,
           profile.timeUsage.blitzHustle);

    printf("info string CHARACTER taunts enabled=%s file='%s' intensity=%d rudeness=%d whenLosing=%d\n",
           profile.taunts.tauntingEnabled ? "true" : "false",
           profile.taunts.tauntFile.c_str(),
           profile.taunts.tauntIntensity,
           profile.taunts.tauntRudeness,
           profile.taunts.tauntWhenLosing);
}

// Simple JSON dump helper for external tools / web UI. This is deliberately
// minimal and focused on high-level knobs; it is not a full serialization of
// all eval weights.
void DumpCharacterJson(const CharacterProfile &profile) {

    printf("{\n");
    printf("  \"id\": \"%s\",\n", profile.id.c_str());
    printf("  \"description\": \"%s\",\n", profile.description.c_str());

    printf("  \"strength\": {\n");
    printf("    \"targetElo\": %d,\n", profile.strength.targetElo);
    printf("    \"useWeakening\": %s,\n", profile.strength.useWeakening ? "true" : "false");
    printf("    \"searchSkill\": %d,\n", profile.strength.searchSkill);
    printf("    \"selectivity\": %d,\n", profile.strength.selectivity);
    printf("    \"slowMover\": %d\n", profile.strength.slowMover);
    printf("  },\n");

    printf("  \"books\": {\n");
    printf("    \"guideBookFile\": \"%s\",\n", profile.books.guideBookFile.c_str());
    printf("    \"mainBookFile\": \"%s\",\n", profile.books.mainBookFile.c_str());
    printf("    \"maxGuideBookPly\": %d,\n", profile.books.maxGuideBookPly);
    printf("    \"maxMainBookPly\": %d,\n", profile.books.maxMainBookPly);
    printf("    \"bookFilter\": %d\n", profile.books.bookFilter);
    printf("  },\n");

    printf("  \"time\": {\n");
    printf("    \"timePercentage\": %d,\n", profile.timeUsage.timePercentage);
    printf("    \"timeNervousness\": %d,\n", profile.timeUsage.timeNervousness);
    printf("    \"blitzHustle\": %d,\n", profile.timeUsage.blitzHustle);
    printf("    \"minThinkTimePercent\": %d\n", profile.timeUsage.minThinkTimePercent);
    printf("  },\n");

    printf("  \"taunts\": {\n");
    printf("    \"enabled\": %s,\n", profile.taunts.tauntingEnabled ? "true" : "false");
    printf("    \"tauntFile\": \"%s\",\n", profile.taunts.tauntFile.c_str());
    printf("    \"intensity\": %d,\n", profile.taunts.tauntIntensity);
    printf("    \"rudeness\": %d,\n", profile.taunts.tauntRudeness);
    printf("    \"whenLosing\": %d,\n", profile.taunts.tauntWhenLosing);
    printf("    \"userBlunderDelta\": %d,\n", profile.taunts.tauntUserBlunderDelta);
    printf("    \"engineBlunderDelta\": %d,\n", profile.taunts.tauntEngineBlunderDelta);
    printf("    \"smallGainMin\": %d,\n", profile.taunts.tauntSmallGainMin);
    printf("    \"smallGainMax\": %d,\n", profile.taunts.tauntSmallGainMax);
    printf("    \"balanceWindow\": %d,\n", profile.taunts.tauntBalanceWindow);
    printf("    \"advantageThreshold\": %d,\n", profile.taunts.tauntAdvantageThreshold);
    printf("    \"winningThreshold\": %d,\n", profile.taunts.tauntWinningThreshold);
    printf("    \"crushingThreshold\": %d\n", profile.taunts.tauntCrushingThreshold);
    printf("  }\n");

    printf("}\n");
}


