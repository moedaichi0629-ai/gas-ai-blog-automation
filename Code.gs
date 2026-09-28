/**
 * AIブログ記事自動生成ツール
 *
 * 現段階でできること：
 *   - スプレッドシートに「記事生成」メニューを追加する
 *   - 選択行のキーワード・サブキーワードをもとに、Claude API で記事を生成する
 *     （タイトル・本文・メタディスクリプションをシートに書き込む）
 *   - testClaudeApi() で Claude API との接続確認ができる
 *   - testWordPressPayload() で WordPress へ送る予定のデータ（payload）を確認できる
 *
 * ※ WordPress への実際の送信はまだ実装していません。
 */

// ============================================================
// 設定値（列番号など）
// 列の並びが変わったときは、ここだけ直せばOKにしています。
// ============================================================
const CONFIG = {
  HEADER_ROW: 1,            // ヘッダー（見出し）がある行番号
  COL_KEYWORD: 1,           // A列：キーワード
  COL_SUB_KEYWORD: 2,       // B列：サブキーワード
  COL_STATUS: 3,            // C列：ステータス
  COL_TITLE: 4,             // D列：タイトル
  COL_WP_URL: 5,            // E列：WordPress URL（今後使用）
  COL_CONTENT: 6,           // F列：記事本文
  COL_META_DESCRIPTION: 7,  // G列：メタディスクリプション

  // 記事本文の文字数の指定範囲（生成後のチェックに使用）
  CONTENT_MIN_LENGTH: 2000,
  CONTENT_MAX_LENGTH: 3000,
};

// C列に書き込むステータスの文言
const STATUS = {
  GENERATING: '生成中',
  GENERATED: '生成済み',
  ERROR: '生成エラー',
};

// ============================================================
// Claude API の設定値
// ============================================================
const CLAUDE_CONFIG = {
  API_URL: 'https://api.anthropic.com/v1/messages', // Claude API の送信先URL
  API_VERSION: '2023-06-01',                         // APIのバージョン（ヘッダーで必ず指定する決まり）
  MODEL: 'claude-sonnet-4-6',                        // 使用するモデル
  PROPERTY_KEY_NAME: 'CLAUDE_API_KEY',               // スクリプトプロパティに保存したAPIキーの名前

  // 記事生成時の返答の最大トークン数（返答の長さの上限）
  // 日本語3,000文字の記事は、JSONの記号込みでおよそ3,000〜5,000トークン程度になります。
  // 途中で切れないよう余裕を持たせつつ、生成時間がGASの6分制限を超えないよう 8,000 にしています。
  ARTICLE_MAX_TOKENS: 8000,
};

// ============================================================
// WordPress の設定値
// ============================================================
// 【将来の送信について（今はまだ送信しません）】
//   送信先：https://example-saas.co.jp/wp-json/wp/v2/posts へ POST する想定
//   認証　：WordPress の「アプリケーションパスワード」を使う想定
//   ユーザー名・パスワード・URL は、Claude APIキーと同じく
//   スクリプトプロパティに保存し、コードには直接書かないようにします。
const WP_CONFIG = {
  // 投稿ステータス。必ず 'draft'（下書き）にします。
  // 'publish'（公開）にすると、確認前の記事がサイトに公開されてしまうため絶対に変更しないでください。
  POST_STATUS: 'draft',
};

// ============================================================
// 記事生成用のプロンプト（Claudeへの指示文）
// ============================================================

// トーンマナーの参考記事（文体・構成・語りかけ方の参考用。内容はコピーさせない）
const REFERENCE_ARTICLE = `「うちはまだ社員数もそこまで多くないし、勤怠管理はエクセルで回せている」——そう考えている労務・総務担当の方は少なくありません。確かにエクセルは手軽で、追加コストもかからない優秀なツールです。ただ、会社の成長や働き方の変化に合わせて、いつのまにか“見えないコスト”が膨らんでいることも事実です。この記事では、エクセル勤怠を続けるうえで担当者が見落としがちな3つの落とし穴を、現場目線で整理します。

## 落とし穴①：集計ミスは「気づけないまま」積み上がる

エクセル勤怠で最も多いトラブルが、関数のズレやコピペミスによる集計誤りです。1人分の残業時間が数分ずれるだけなら気づきにくいですが、それが数十人・十数か月分積み重なると、未払い残業として後から大きな金額で表面化することがあります。しかもエクセルは「誰がいつ何を変更したか」の履歴が残らないため、原因の特定にも時間がかかります。月末のたびに担当者が電卓で検算している——そんな状態は、すでにエクセルの限界サインかもしれません。

## 落とし穴②：法改正への対応が、どうしても後手に回る

働き方関連の法改正は、ここ数年だけでも「有給休暇の年5日取得義務」「36協定の残業上限規制」「割増賃金率の引き上げ」など立て続けに行われています。エクセル運用の場合、こうした改正のたびに数式やシートを自前で組み直す必要があり、対応が遅れるほど労務リスクが高まります。特に有給5日の取得状況や、残業の上限超過は「うっかり見落とした」では済まされない領域です。

## 落とし穴③：テレワークや多様な働き方に追いつけない

オフィス出社が前提だった頃は、タイムカードやエクセルでも十分でした。しかしテレワーク・時差出勤・中抜けといった柔軟な働き方が広がると、「いつ・どこで・どれだけ働いたか」を正確に記録すること自体が難しくなります。自己申告ベースのエクセルでは、打刻漏れや申告忘れが増え、結果として正確な労働時間の把握ができなくなる——これは、従業員にとっても会社にとっても不幸な状態です。

## まとめ：エクセルが悪いのではなく、「フェーズ」の問題

ここまで3つの落とし穴を挙げましたが、エクセルそのものが悪いわけではありません。大切なのは、自社の人数・働き方が「エクセルで回せるフェーズ」を超えていないかを定期的に見直すことです。まずは、月末の勤怠集計に毎月どれくらいの工数がかかっているかを可視化してみてください。その時間が「本来やるべき仕事」を圧迫しているなら、それがシステム化を検討するベストなタイミングです。`;

// システムプロンプト（Claudeの役割・記事仕様・出力形式をまとめた指示）
// ※ キーワードは記事ごとに変わるので、ここではなくユーザーメッセージ側で渡します
const ARTICLE_SYSTEM_PROMPT = `あなたはBtoB SaaSのマーケティングライターです。
クラウド勤怠管理ツール「キンタイ Cloud」のオウンドメディアに掲載するSEO記事を執筆します。

# ターゲット読者
中小企業の経営者・IT担当者

# 記事仕様
- メインキーワードを、不自然にならない範囲で含める
- サブキーワードも、可能な範囲で自然に含める
- 構成：
  - タイトル
  - 導入（約300字）
  - H2見出し × 3（それぞれ本文つき）
  - まとめ（約200字。見出しはH2で「まとめ」を含める）

# 本文の文字数（重要）
- 本文（content）は必ず2,000〜3,000文字の範囲に収めてください。2,000文字未満は不可です
- 安定して2,000文字以上にするため、2,200〜2,700文字程度を目標に執筆してください
- 文字数の配分の目安：
  - 導入：約300字
  - H2見出し1つあたり：約550〜700字（3つで約1,700〜2,100字）
  - まとめ：約200〜300字
- 各H2では、要点を述べるだけで終わらせず、「なぜそうなるのか」の説明と、読者の職場で起こりそうな具体的な場面・例を必ず入れてください
- 導入では読者が抱えていそうな悩みや状況を具体的に描き、まとめでは読者が次に取れる行動を示してください
- 文字数を増やすためだけの、同じ内容の言い換えや繰り返しは避けてください
- 下の参考記事は全体で約1,100文字と短めです。参考にするのは文体だけで、文字数は参考記事に合わせず、上記の目標に従ってください
- 専門知識がない読者にも理解できる文章にする
- カジュアルだが専門性のあるトーンにする
- 既存記事のコピーではなく、オリジナルの表現を心がける
- 事実を断定しすぎない。統計データ・具体的な数値・法令の細かな条文・「キンタイ Cloud」の具体的な機能や料金など、確認できない情報を作り出さない
- この記事は、AI生成後に人間が確認・編集する下書きです

# トーンマナーの参考記事
以下の記事の文体・構成・読者への語りかけ方を参考にしてください。
内容そのものはコピーせず、トーンマナーのみ参考にしてください。

<reference_article>
${REFERENCE_ARTICLE}
</reference_article>

# 出力形式（厳守）
返答は、プログラムでそのまま JSON.parse() できる「有効なJSON」1つだけにしてください。

## 守ること
- 返答の1文字目は「{」、最後の文字は「}」にする
- JSON以外の文章（前置き・説明・補足・「以下が記事です」などの一言）は一切出力しない
- Markdownのコードフェンス（\`\`\`json や \`\`\`）で囲まない
- キーは title、content、metaDescription の3つだけにする。それ以外のキーは追加しない
- 値はすべて文字列にする

## 形式
{
  "title": "記事タイトル",
  "content": "記事本文",
  "metaDescription": "120字以内のメタディスクリプション"
}

- title：記事タイトル（32字前後を目安に、メインキーワードを含める）
- content：導入からまとめまでの記事本文。タイトルは含めない。H2見出しは行頭を「## 」にしたMarkdown形式で書いてよい。段落の間は空行で区切る
- metaDescription：120字以内。検索結果に表示される記事の要約

## JSON文字列のエスケープ（最重要）
記事本文は長文のため、エスケープ漏れがあるとJSON全体が壊れて読み込めなくなります。次のルールを必ず守ってください。
- 文字列の中で改行するときは、実際の改行を入れず、必ず \\n と書く（空行は \\n\\n）
- 文字列の中でダブルクォーテーション（"）を使う場合は、必ず \\" と書く
- 文字列の中でバックスラッシュ（\\）を使う場合は、必ず \\\\ と書く
- タブなどの制御文字は使わない

## ダブルクォーテーションをできるだけ使わない
- 本文・タイトル・メタディスクリプションでの強調や引用、用語の囲みには、ダブルクォーテーション（"）や “ ” ではなく、かぎかっこ「」や『』を使ってください
- 半角のダブルクォーテーションは、JSONの構文以外ではできるだけ使わないでください

## 正しい出力の例（形の例です。内容は真似しないでください）
{"title": "勤怠管理を見直すタイミングとは？","content": "導入の文章です。\\n\\n## 1つ目の見出し\\n\\n「かぎかっこ」を使った本文です。\\n\\n## まとめ\\n\\nまとめの文章です。","metaDescription": "メタディスクリプションの例です。"}`;

/**
 * スプレッドシートを開いたときに自動で実行される関数です。
 * （関数名を「onOpen」にすると、GASが自動で呼び出してくれます）
 * 画面上部に「記事生成」メニューを追加します。
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('記事生成')                                   // メニューの名前
    .addItem('選択行の記事を生成', 'generateArticleForSelectedRow') // 項目名, 押したときに実行する関数名
    .addToUi();                                               // 画面に反映
}

/**
 * 「選択行の記事を生成」を押したときに実行される関数です。
 * 選択中の行のキーワード・サブキーワードをもとに Claude で記事を生成し、
 * タイトル・本文・メタディスクリプションをシートに書き込みます。
 */
function generateArticleForSelectedRow() {
  const ui = SpreadsheetApp.getUi();

  // 今開いているシートと、選択中のセルを取得
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();

  // 念のため、何も選択されていない場合をチェック
  if (!activeRange) {
    ui.alert('エラー', '記事を生成したい行を選択してください。', ui.ButtonSet.OK);
    return;
  }

  // 選択範囲の「一番上の行番号」を取得
  // （複数行を選択していても、現段階では先頭の1行だけを処理します）
  const row = activeRange.getRow();

  // ヘッダー行（1行目）が選択されている場合は処理しない
  if (row <= CONFIG.HEADER_ROW) {
    ui.alert('エラー', '1行目は見出し行のため処理できません。\n2行目以降のデータ行を選択してください。', ui.ButtonSet.OK);
    return;
  }

  // 選択行のA列（キーワード）とB列（サブキーワード）の値を取得
  // String() で文字列に変換し、trim() で前後の空白を取り除きます
  const keyword = String(sheet.getRange(row, CONFIG.COL_KEYWORD).getValue()).trim();
  const subKeyword = String(sheet.getRange(row, CONFIG.COL_SUB_KEYWORD).getValue()).trim();

  // キーワードが空欄の場合はエラーを表示して終了
  if (keyword === '') {
    ui.alert('エラー', row + '行目のキーワード（A列）が空欄です。\nキーワードを入力してから再度実行してください。', ui.ButtonSet.OK);
    return;
  }

  // すでに本文が入っている場合は、上書きしてよいか確認する
  // （API利用料がかかるので、うっかり再生成を防ぐため）
  const existingContent = String(sheet.getRange(row, CONFIG.COL_CONTENT).getValue()).trim();
  if (existingContent !== '') {
    const answer = ui.alert(
      '確認',
      row + '行目にはすでに記事本文があります。\n再生成して上書きしますか？',
      ui.ButtonSet.YES_NO
    );
    if (answer !== ui.Button.YES) {
      return;
    }
  }

  // ステータスセル（C列）
  const statusCell = sheet.getRange(row, CONFIG.COL_STATUS);

  try {
    // C列を「生成中」にする
    // flush() で、処理の途中でもシートの表示をすぐに更新します
    statusCell.setValue(STATUS.GENERATING);
    SpreadsheetApp.flush();

    // Claude API で記事を生成（JSON文字列が返ってくる）
    const userMessage =
      '以下のキーワードでSEO記事を作成してください。\n' +
      'メインキーワード：' + keyword + '\n' +
      'サブキーワード：' + (subKeyword === '' ? '（なし）' : subKeyword);

    const replyText = callClaudeApi_(userMessage, CLAUDE_CONFIG.ARTICLE_MAX_TOKENS, ARTICLE_SYSTEM_PROMPT);

    // 返ってきたJSONを解析して、タイトル・本文・メタディスクリプションを取り出す
    const article = parseArticleJson_(replyText);

    // シートに書き込む（D列：タイトル、F列：本文、G列：メタディスクリプション）
    sheet.getRange(row, CONFIG.COL_TITLE).setValue(article.title);
    sheet.getRange(row, CONFIG.COL_CONTENT).setValue(article.content);
    sheet.getRange(row, CONFIG.COL_META_DESCRIPTION).setValue(article.metaDescription);

    // C列を「生成済み」にする
    statusCell.setValue(STATUS.GENERATED);
    SpreadsheetApp.flush();

    // 本文の文字数が指定範囲内かチェック
    // （範囲外でも自動で再生成はせず、警告を表示するだけにしています）
    const contentLength = article.content.length;
    let lengthWarning = '';
    if (contentLength < CONFIG.CONTENT_MIN_LENGTH || contentLength > CONFIG.CONTENT_MAX_LENGTH) {
      lengthWarning =
        '⚠ 文字数が指定範囲外です。内容を確認してください' +
        '（指定範囲：' + CONFIG.CONTENT_MIN_LENGTH + '〜' + CONFIG.CONTENT_MAX_LENGTH + '文字）\n\n';
    }

    ui.alert(
      '記事生成完了',
      row + '行目の記事を生成しました。\n\n' +
      'タイトル：' + article.title + '\n' +
      '本文の文字数：約' + contentLength + '文字\n\n' +
      lengthWarning +
      '※ AIが作成した下書きです。公開前に必ず内容を確認・編集してください。',
      ui.ButtonSet.OK
    );
  } catch (e) {
    // 途中でエラーが起きたら、C列を「生成エラー」にしてエラー内容を表示
    statusCell.setValue(STATUS.ERROR);
    Logger.log('記事生成エラー（' + row + '行目）：' + e.message);
    ui.alert('生成エラー', row + '行目の記事生成に失敗しました。\n\n' + e.message, ui.ButtonSet.OK);
  }
}

/**
 * Claude から返ってきた文字列をJSONとして解析し、記事データを返します。
 * 必要な項目（title / content / metaDescription）がそろっているかも確認します。
 *
 * @param {string} text Claudeの返答テキスト
 * @return {{title: string, content: string, metaDescription: string}} 記事データ
 */
function parseArticleJson_(text) {
  let jsonText = text.trim();

  // 万が一「```json ... ```」のようなコードフェンスで囲まれていたら取り除く
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  // それでも前後に説明文などが付いている場合に備えて、
  // 最初の「{」から最後の「}」までを切り出す
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Claudeの返答にJSONが見つかりませんでした。\n返答の冒頭：' + text.slice(0, 200));
  }
  jsonText = jsonText.slice(start, end + 1);

  // JSONとして解析
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    throw new Error('Claudeの返答をJSONとして解析できませんでした（' + e.message + '）\n返答の冒頭：' + text.slice(0, 200));
  }

  // 必要な項目が「空でない文字列」として存在するか確認
  const requiredKeys = ['title', 'content', 'metaDescription'];
  requiredKeys.forEach(function (key) {
    if (typeof data[key] !== 'string' || data[key].trim() === '') {
      throw new Error('Claudeの返答JSONに「' + key + '」がないか、空になっています。');
    }
  });

  return {
    title: data.title.trim(),
    content: data.content.trim(),
    metaDescription: data.metaDescription.trim(),
  };
}

// ============================================================
// Claude API 関連
// ============================================================

/**
 * スクリプトプロパティから Claude APIキーを取得します。
 * キーが見つからない場合は、設定方法が分かるエラーを投げます。
 *
 * ※ 関数名の最後に「_」を付けると、GASの実行メニューに表示されない
 *   「内部用の関数」になります。
 */
function getClaudeApiKey_() {
  const apiKey = PropertiesService.getScriptProperties().getProperty(CLAUDE_CONFIG.PROPERTY_KEY_NAME);

  // キーが未設定（null）または空文字の場合はエラー
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'Claude APIキーが見つかりません。\n' +
      'Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」に\n' +
      'プロパティ名「' + CLAUDE_CONFIG.PROPERTY_KEY_NAME + '」でAPIキーを保存してください。'
    );
  }

  return apiKey.trim();
}

/**
 * Claude API にメッセージを1回送り、返ってきたテキストを返す共通関数です。
 *
 * @param {string} prompt          Claudeへ送る指示文（ユーザーメッセージ）
 * @param {number} maxTokens       返答の最大トークン数（返答の長さの上限）
 * @param {string} [systemPrompt]  Claudeの役割やルールを伝える指示（省略可）
 * @return {string} Claudeから返ってきたテキスト
 */
function callClaudeApi_(prompt, maxTokens, systemPrompt) {
  const apiKey = getClaudeApiKey_();

  // Claude API に送るデータ（リクエスト本文）
  const payload = {
    model: CLAUDE_CONFIG.MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'user', content: prompt },
    ],
  };

  // システムプロンプトが指定されているときだけ追加する
  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  // UrlFetchApp.fetch() に渡す設定
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,                          // APIキー（※ログには絶対に出さない）
      'anthropic-version': CLAUDE_CONFIG.API_VERSION,
    },
    payload: JSON.stringify(payload),
    // true にすると、エラー時（400番台・500番台）でも例外で止まらず
    // レスポンスを受け取れるので、エラー内容を自分で確認できます
    muteHttpExceptions: true,
  };

  // Claude API へ送信
  const response = UrlFetchApp.fetch(CLAUDE_CONFIG.API_URL, options);

  // HTTPステータスコードと、レスポンス本文（JSON文字列）を取得
  const statusCode = response.getResponseCode();
  const bodyText = response.getContentText();

  // ステータスコードが 200 以外なら失敗
  if (statusCode !== 200) {
    // エラー時のレスポンス本文には、エラーの種類と理由が入っています。
    // （APIキーは含まれないので、ログに出しても安全です）
    let errorDetail = bodyText;
    try {
      const errorJson = JSON.parse(bodyText);
      if (errorJson.error) {
        errorDetail = errorJson.error.type + '：' + errorJson.error.message;
      }
    } catch (e) {
      // JSONでない場合は本文をそのまま使う
    }
    throw new Error('Claude API エラー（HTTPステータス ' + statusCode + '）\n' + errorDetail);
  }

  const json = JSON.parse(bodyText);

  // stop_reason（返答が終わった理由）を確認
  //   max_tokens：上限に達して、返答が途中で切れている
  //   refusal   ：Claudeが安全上の理由で返答を断った
  if (json.stop_reason === 'max_tokens') {
    throw new Error('返答が最大トークン数（' + maxTokens + '）に達し、途中で切れました。max_tokens を増やしてください。');
  }
  if (json.stop_reason === 'refusal') {
    throw new Error('Claudeが返答を断りました。指示内容を見直してください。');
  }

  // テキスト部分だけを取り出す
  // （content は配列なので、type が "text" のものを集めてつなげます）
  const text = json.content
    .filter(function (block) { return block.type === 'text'; })
    .map(function (block) { return block.text; })
    .join('');

  return text;
}

/**
 * Claude API との接続確認用の関数です。
 * Apps Script のエディタから手動で実行してください。
 * 結果は「実行ログ」に表示されます。
 */
function testClaudeApi() {
  // 長文を生成させず、短い一言だけ返すよう指示する
  const prompt = '接続テストです。「接続テスト成功」とだけ、日本語で返答してください。';

  try {
    Logger.log('Claude API 接続テストを開始します（モデル：' + CLAUDE_CONFIG.MODEL + '）');

    // 短い返答で十分なので、max_tokens は小さめにしています
    const reply = callClaudeApi_(prompt, 100);

    Logger.log('✅ 接続成功！Claudeからの返答：' + reply);
  } catch (e) {
    // エラー内容をログに出力（APIキーは含まれません）
    Logger.log('❌ 接続失敗：' + e.message);
    // 実行ログ上でも「失敗」と分かるように、エラーを再度投げる
    throw e;
  }
}

// ============================================================
// WordPress 関連
// ============================================================

/**
 * WordPress REST API へ送る投稿データ（payload）を作成します。
 * 将来の実送信でも、この関数で作ったデータをそのまま使う予定です。
 *
 * @param {string} title           記事タイトル（D列）
 * @param {string} content         記事本文（F列。現在はMarkdown形式のまま）
 * @param {string} metaDescription メタディスクリプション（G列）
 * @return {Object} WordPress へ送る投稿データ
 */
function buildWordPressPayload_(title, content, metaDescription) {
  const payload = {
    title: title,                  // 記事タイトル
    content: content,              // 記事本文（※ Markdown→HTML変換は実送信の段階で検討）
    status: WP_CONFIG.POST_STATUS, // 投稿ステータス（必ず下書き）
    excerpt: metaDescription,      // 抜粋（メタディスクリプションを設定）
  };

  // 安全確認：万が一 status が 'draft' 以外になっていたら処理を止める
  // （確認前の記事が公開されてしまう事故を防ぐため）
  if (payload.status !== 'draft') {
    throw new Error('投稿ステータスが「draft」（下書き）ではありません（現在：' + payload.status + '）。WP_CONFIG.POST_STATUS を確認してください。');
  }

  return payload;
}

/**
 * WordPress へ送信する予定のデータ（payload）を確認するテスト用の関数です。
 * 選択行のタイトル・本文・メタディスクリプションから payload を作成し、
 * 実行ログに表示します。
 *
 * ※ 実際の WordPress には送信しません（UrlFetchApp.fetch() は使っていません）。
 */
function testWordPressPayload() {
  const ui = SpreadsheetApp.getUi();

  // 今開いているシートと、選択中のセルを取得
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();

  // 何も選択されていない場合
  if (!activeRange) {
    ui.alert('エラー', '確認したい記事の行を選択してください。', ui.ButtonSet.OK);
    return;
  }

  // 選択範囲の一番上の行番号を取得
  const row = activeRange.getRow();

  // ヘッダー行（1行目）が選択されている場合は処理しない
  if (row <= CONFIG.HEADER_ROW) {
    ui.alert('エラー', '1行目は見出し行のため処理できません。\n2行目以降のデータ行を選択してください。', ui.ButtonSet.OK);
    return;
  }

  // 選択行の D列（タイトル）・F列（本文）・G列（メタディスクリプション）を取得
  const title = String(sheet.getRange(row, CONFIG.COL_TITLE).getValue()).trim();
  const content = String(sheet.getRange(row, CONFIG.COL_CONTENT).getValue()).trim();
  const metaDescription = String(sheet.getRange(row, CONFIG.COL_META_DESCRIPTION).getValue()).trim();

  // タイトルまたは本文が空の場合はエラーを表示して終了
  if (title === '' || content === '') {
    ui.alert(
      'エラー',
      row + '行目のタイトル（D列）または記事本文（F列）が空欄です。\n' +
      '先に「記事生成」→「選択行の記事を生成」で記事を作成してください。',
      ui.ButtonSet.OK
    );
    return;
  }

  try {
    // WordPress へ送る予定のデータを作成
    const payload = buildWordPressPayload_(title, content, metaDescription);

    // 実行ログに表示
    // まず概要を表示し、そのあと送信データ全体（JSON）を表示します
    Logger.log('===== WordPress 送信データ（' + row + '行目）=====');
    Logger.log('※ これは確認用です。WordPress には送信していません。');
    Logger.log('status：' + payload.status);
    Logger.log('title：' + payload.title);
    Logger.log('excerpt：' + payload.excerpt);
    Logger.log('content の文字数：' + payload.content.length + '文字');
    Logger.log('----- 送信データ全体（JSON）-----');
    // JSON.stringify の第3引数「2」は、見やすいように字下げして表示するための指定です
    Logger.log(JSON.stringify(payload, null, 2));

    ui.alert('確認', 'WordPress送信データを作成しました。実行ログを確認してください。', ui.ButtonSet.OK);
  } catch (e) {
    Logger.log('WordPress送信データの作成エラー（' + row + '行目）：' + e.message);
    ui.alert('エラー', 'WordPress送信データの作成に失敗しました。\n\n' + e.message, ui.ButtonSet.OK);
  }
}
