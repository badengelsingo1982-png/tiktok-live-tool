# TikTok LIVE 配信ツール(自分用MVP)

TikFinityと同じ仕組みの自分用ミニ版。ギフト/コメント/フォロー/いいねをリアルタイム受信して、OBS用オーバーレイにアラート表示・効果音・TTS読み上げを行います。

## セットアップ

```bash
npm install
node server.js
```

1. ブラウザで管理画面を開く → http://localhost:8181/dashboard
2. TikTokユーザー名(@なし)を入力して「接続」※**配信中のアカウントのみ接続可能**
3. OBS / TikTok LIVE Studio の「ブラウザソース」に以下を登録
   - URL: `http://localhost:8181/overlay`
   - 幅 1920 / 高さ 1080
4. 管理画面のテストボタンでオーバーレイの動作確認(配信してなくてもOK)

## 機能

- **ギフトアラート**: 中央上部にポップアップ+効果音+TTS。連打ギフトは確定時のみ表示(重複防止済み)
- **コメント表示**: 左下に最新8件。TTS読み上げ対応(ブラウザ内蔵の音声合成、無料)
- **フォロー/シェアアラート**
- **いいねカウンター**: 右下に累計表示
- **管理画面**: 接続状態、視聴者数、いいね数、ダイヤ累計、イベントログ

## カスタマイズ

`config.json` で設定変更(再起動で反映):

| 項目 | 内容 |
|---|---|
| `username` | 接続先TikTokユーザー名 |
| `autoConnect` | 起動時に自動接続 |
| `tts.readComments` | コメント読み上げのON/OFF |
| `tts.rate` | 読み上げ速度 |
| `alerts.gift.minDiamonds` | アラートを出す最低ダイヤ数 |
| `alerts.gift.sound` | 効果音ファイルパス |

効果音は `sounds/gift.mp3` `sounds/follow.mp3` を置くと再生されます。無い場合は自動でビープ音になります。

## 注意事項

- `tiktok-live-connector` は非公式ライブラリです。TikTok側の仕様変更で動かなくなる場合があります(その際は `npm update tiktok-live-connector`)
- 接続にログインは不要ですが、頻繁な接続失敗が出る場合はライブラリのSign Server混雑が原因のことが多いので時間を置いて再試行してください
- OBSのブラウザソースで音が出ない場合: ソースのプロパティで「音声をコントロールする」にチェック、または「ページと相互作用」で一度クリックして音声再生を許可

## 拡張アイデア(次のステップ)

- ギフト目標バー(○○ダイヤでチャレンジ達成、goalUpdate イベント対応)
- 特定ギフトで特定アクション(TikFinityのActions & Events相当)→ server.js の GIFT ハンドラにルール分岐を追加
- VOICEVOX連携で高品質TTS(ローカルでVOICEVOXエンジン起動→ /audio_query & /synthesis を叩く)
- コメントへの自動返信チャットボット(Claude API連携)
