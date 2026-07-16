cask "claude-usage-tracker" do
  version "1.1.0"

  on_intel do
    sha256 "28d966a01b040cec86d9ee1c265ba41f9a6d736b9f35ff76df8c505c5df2eb45"
    url "https://github.com/DhyeyTandel/Claude_Usage_Tracker/releases/download/v#{version}/Claude-Usage-Tracker-#{version}.dmg"
  end
  on_arm do
    sha256 "84becfe9ba551e19c95831fe36a5423dae86d61ebca738104c5a57d121077dfd"
    url "https://github.com/DhyeyTandel/Claude_Usage_Tracker/releases/download/v#{version}/Claude-Usage-Tracker-#{version}-arm64.dmg"
  end

  name "Claude Usage Tracker"
  desc "Track Claude Code usage and Anthropic API spend"
  homepage "https://github.com/DhyeyTandel/Claude_Usage_Tracker"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Claude Usage Tracker.app"

  zap trash: [
    "~/Library/Application Support/claude-usage-tracker",
    "~/Library/Logs/claude-usage-tracker",
    "~/Library/Preferences/com.dhyey.claude-usage-tracker.plist",
    "~/Library/Saved Application State/com.dhyey.claude-usage-tracker.savedState",
  ]
end
