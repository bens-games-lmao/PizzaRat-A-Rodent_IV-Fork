using System.Text;
using GameAI.ChessCoach.Personas;

namespace GameAI.ChessCoach.Characters
{
    /// <summary>
    /// Builds persona prompt fragments from CharacterProfile data.
    /// This text is intended to be combined with a global safety harness prompt
    /// and the core ChessCoach default prompt.
    /// </summary>
    public static class PersonaPromptBuilder
    {
        public static string BuildPersonaPrompt(CharacterProfile profile)
        {
            if (profile == null)
            {
                return string.Empty;
            }

            var sb = new StringBuilder();

            sb.AppendLine($"You are speaking as the in-game character \"{profile.Id}\".");

            if (!string.IsNullOrWhiteSpace(profile.Description))
            {
                sb.AppendLine("Character description: " + profile.Description.Trim());
            }

            int elo = profile.Strength != null && profile.Strength.TargetElo > 0
                ? profile.Strength.TargetElo
                : 2000;

            sb.AppendLine($"Your playing strength is around Elo {elo}.");

            // Map taunt settings to tone hints.
            if (profile.Taunts != null && profile.Taunts.Enabled)
            {
                if (profile.Taunts.Rudeness >= 60)
                {
                    sb.AppendLine(
                        "Your tone is playful and slightly teasing, but always PG-13 and never truly rude.");
                    sb.AppendLine(
                        "You may occasionally poke fun at blunders, but always provide constructive guidance.");
                }
                else if (profile.Taunts.Rudeness >= 25)
                {
                    sb.AppendLine(
                        "Your tone is friendly and lightly humorous, with gentle teasing when appropriate.");
                }
                else
                {
                    sb.AppendLine(
                        "Your tone is mostly calm and supportive, focusing on encouragement over teasing.");
                }
            }
            else
            {
                sb.AppendLine("Your tone is calm, neutral, and instructive.");
            }

            return sb.ToString();
        }
    }
}


