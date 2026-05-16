/**
 * 本地演示歌单与 buildSampleSongs（依赖 window.JUKEBOX_EXTRA_PLAYLIST_TITLES）。
 */
(function (global) {
  var SAMPLE_SONGS_BASE = [
    {
      id: "11111111-1111-4111-8111-111111111101",
      title: "轨迹",
      artist: "周杰伦",
      note: "",
      link_url: "",
      sort_order: 1,
    },
    {
      id: "11111111-1111-4111-8111-111111111102",
      title: "倒带",
      artist: "蔡依林",
      note: "",
      link_url: "",
      sort_order: 2,
    },
    {
      id: "11111111-1111-4111-8111-111111111103",
      title: "恋人",
      artist: "李荣浩",
      note: "",
      link_url: "",
      sort_order: 3,
    },
    {
      id: "11111111-1111-4111-8111-111111111104",
      title: "童话镇",
      artist: "暗杠",
      note: "",
      link_url: "",
      sort_order: 4,
    },
    {
      id: "11111111-1111-4111-8111-111111111105",
      title: "白色风车",
      artist: "周杰伦",
      note: "",
      link_url: "",
      sort_order: 5,
    },
    {
      id: "11111111-1111-4111-8111-111111111106",
      title: "褪黑素",
      artist: "江皓南",
      note: "",
      link_url: "",
      sort_order: 6,
    },
    {
      id: "11111111-1111-4111-8111-111111111107",
      title: "关键字",
      artist: "林俊杰",
      note: "",
      link_url: "",
      sort_order: 7,
    },
    {
      id: "11111111-1111-4111-8111-111111111108",
      title: "嘉宾",
      artist: "张远",
      note: "",
      link_url: "",
      sort_order: 8,
    },
    {
      id: "11111111-1111-4111-8111-111111111109",
      title: "画心",
      artist: "张靓颖",
      note: "",
      link_url: "",
      sort_order: 9,
    },
    {
      id: "11111111-1111-4111-8111-111111111110",
      title: "七月七日晴",
      artist: "许慧欣",
      note: "",
      link_url: "",
      sort_order: 10,
    },
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "呼吸决定",
      artist: "Fine乐队",
      note: "",
      link_url: "",
      sort_order: 11,
    },
    {
      id: "11111111-1111-4111-8111-111111111112",
      title: "邮差",
      artist: "王菲",
      note: "",
      link_url: "",
      sort_order: 12,
    },
  ];

  var SAMPLE_SONG_ARTISTS_CYCLE = [
    "周杰伦",
    "蔡依林",
    "孙燕姿",
    "梁静茹",
    "林俊杰",
    "邓紫棋",
    "王菲",
    "张惠妹",
    "李荣浩",
    "薛之谦",
    "汪苏泷",
    "许嵩",
    "徐佳莹",
    "杨丞琳",
    "田馥甄",
    "陈粒",
    "告五人",
    "五月天",
    "苏打绿",
    "鱼丁糸",
    "陶喆",
    "方大同",
    "郭顶",
    "房东的猫",
    "任然",
    "王心凌",
    "萧亚轩",
    "张韶涵",
    "周深",
    "张碧晨",
    "胡夏",
    "A-lin",
    "杨宗纬",
    "张远",
    "张靓颖",
    "许慧欣",
    "Fine乐队",
    "魏如萱",
    "蔡健雅",
    "莫文蔚",
    "刘若英",
    "光良",
    "品冠",
    "飞儿乐队",
    "Tank",
    "萧敬腾",
    "八三夭",
    "卢广仲",
    "茄子蛋",
    "美秀集团",
  ];

  function normalizePlaylistTitle(s) {
    return String(s || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  /** 本地演示歌单：歌名（规范化后）→ 演唱者；未列出的歌仍用 SAMPLE_SONG_ARTISTS_CYCLE 轮换 */
  var PLAYLIST_ARTIST_BY_TITLE = (function () {
    var m = {};
    function add(title, artist) {
      m[normalizePlaylistTitle(title)] = artist;
    }
    add("多情种", "胡杨林");
    add("尘埃", "家家");
    add("最后一页", "江语晨");
    add("阳光下的星星", "金海心");
    add("叹云兮", "鞠婧祎");
    add("想你就写信", "浪花兄弟");
    add("阿拉斯加海湾", "蓝心羽");
    add("小宇", "蓝心羽");
    add("孤单心事", "蓝又时");
    add("我们", "青柠组合");
    add("情歌", "梁静茹");
    add("勇气", "梁静茹");
    add("会呼吸的痛", "梁静茹");
    add("慢冷", "梁静茹");
    add("暖暖", "梁静茹");
    add("大手拉小手", "梁静茹");
    add("分手快乐", "梁静茹");
    add("always online", "林俊杰");
    add("Always Online", "林俊杰");
    add("江南", "林俊杰");
    add("美人鱼", "林俊杰");
    add("修炼爱情", "林俊杰");
    add("我还想她", "林俊杰");
    add("关键词", "林俊杰");
    add("不为谁而作的歌", "林俊杰");
    add("可惜没如果", "林俊杰");
    add("背对背拥抱", "林俊杰");
    add("一百年以后", "林俊杰");
    add("那些你很冒险的梦", "林俊杰");
    add("醉赤壁", "林俊杰");
    add("一眼万年", "林俊杰");
    add("那女孩对我说", "林俊杰");
    add("将故事写成我们", "林俊杰");
    add("同花顺", "林倛玉");
    add("你（吉他甜蜜版）", "林依晨");
    add("想自由", "林宥嘉");
    add("初恋", "林志美");
    add("恋人", "李荣浩");
    add("礼物", "刘力扬");
    add("心跳的证明", "刘人语");
    add("房间", "刘瑞琪");
    add("后来", "刘若英");
    add("成全", "刘若英");
    add("怎么唱情歌", "刘惜君");
    add("嘉宾", "路飞文");
    add("我们的纪念", "李雅薇");
    add("刻在我心底的名字", "卢广仲");
    add("鱼仔", "卢广仲");
    add("我爱你", "卢广仲");
    add("不值得", "梦飞船");
    add("想念拟人化", "孟慧园");
    add("这世界那么多人", "莫文蔚");
    add("电台情歌", "莫文蔚");
    add("盛夏的果实", "莫文蔚");
    add("阴天", "莫文蔚");
    add("喜欢两个人", "莫文蔚");
    add("疑心病", "任然");
    add("那年", "任然");
    add("无人之岛", "任然");
    add("飞鸟和蝉", "任然");
    add("外愈", "任然");
    add("水星记", "任然");
    add("我怀念的", "孙燕姿");
    add("开始懂了", "孙燕姿");
    add("天黑黑", "孙燕姿");
    add("逆光", "孙燕姿");
    add("半句再见", "孙燕姿");
    add("眼泪成诗", "孙燕姿");
    add("普通朋友", "陶喆");
    add("melody", "陶喆");
    add("Melody", "陶喆");
    add("流沙", "陶喆");
    add("寂寞的季节", "陶喆");
    add("无人知晓", "田馥甄");
    add("寂寞寂寞就好", "田馥甄");
    add("魔鬼中的天使", "田馥甄");
    add("小幸运", "田馥甄");
    add("你就不要想起我", "田馥甄");
    add("匆匆那年", "王菲");
    add("红豆", "王菲");
    add("六年", "王菲");
    add("流年", "王菲");
    add("棋子", "王菲");
    add("爱与痛的边缘", "王菲");
    add("邮差", "王菲");
    add("爱错", "王力宏");
    add("无情画", "王唯旖");
    add("舍得", "王唯旖");
    add("黄昏晓", "王心凌");
    add("大眠", "王心凌");
    add("如果可以", "韦礼安");
    add("夏天的风", "温岚");
    add("错的人", "萧亚轩");
    add("遗失的心跳", "萧亚轩");
    add("最好", "薛之谦");
    add("七月七日晴", "许慧欣");
    add("到此为止", "徐佳莹");
    add("突然好想你", "徐佳莹");
    add("红装", "徐良");
    add("七秒钟记忆", "徐良");
    add("坏女孩", "徐良");
    add("客官不可以", "徐良");
    add("飞机场", "徐良");
    add("雨爱", "杨丞琳");
    add("匿名的好友", "杨丞琳");
    add("带我走", "杨丞琳");
    add("仰望", "杨丞琳");
    add("年轮说", "杨丞琳");
    add("情深深雨濛濛", "杨胖雨");
    add("九张机", "叶炫清");
    add("落空", "印子月");
    add("说散就散", "袁娅维");
    add("旅行中忘记", "袁娅维");
    add("一生等你", "袁娅维");
    add("春泥", "余超颖");
    add("体面", "于文文");
    add("蠢货", "喻言");
    add("给我一个理由忘记", "A-lin");
    add("天若有情", "A-lin");
    add("有一种悲伤", "A-lin");
    add("拿走了什么", "A-lin");
    add("幸福了 然后呢", "A-lin");
    add("失恋无罪", "A-lin");
    add("无人知晓的我", "A-lin");
    add("忘记拥抱", "A-lin");
    add("童话镇", "暗杠");
    add("一直很安静", "阿桑");
    add("叶子", "阿桑");
    add("越来越不懂", "蔡健雅");
    add("空白格", "蔡健雅");
    add("letting go", "蔡健雅");
    add("Letting Go", "蔡健雅");
    add("红色高跟鞋", "蔡健雅");
    add("别找我麻烦", "蔡健雅");
    add("被驯服的象", "蔡健雅");
    add("达尔文", "蔡健雅");
    add("倒带", "蔡依林");
    add("妥协", "蔡依林");
    add("一个人想着一个人", "曾沛慈");
    add("够爱", "曾沛慈");
    add("虚拟", "陈粒");
    add("奇妙能力歌", "陈粒");
    add("小半", "陈粒");
    add("太聪明", "陈绮贞");
    add("旅行的意义", "陈绮贞");
    add("还是会寂寞", "陈绮贞");
    add("爱情的骗子我问你", "陈小云");
    add("爱的回归线", "陈韵若");
    add("从此以后", "呆呆破");
    add("永不失联的爱", "单依纯");
    add("在夜里跳舞", "单依纯");
    add("想你时风起", "单依纯");
    add("我只在乎你", "邓丽君");
    add("猜不透", "丁当");
    add("我爱他", "丁当");
    add("繁花", "堇真");
    add("月牙湾", "飞儿乐队");
    add("我们的爱", "飞儿乐队");
    add("你的微笑", "飞儿乐队");
    add("Lydia", "飞儿乐队");
    add("千年之恋", "飞儿乐队");
    add("特别的人", "方大同");
    add("吹灭小山河", "绯绯er");
    add("呼吸决定", "Fine乐队");
    add("唯一", "邓紫棋");
    add("泡沫", "邓紫棋");
    add("多远都要在一起", "邓紫棋");
    add("句号", "邓紫棋");
    add("爱人错过", "告五人");
    add("你在 不在", "郭采洁");
    add("爱情讯息", "郭静");
    add("下一个天亮", "郭静");
    add("舞女泪", "韩宝仪");
    add("你是我的风景", "何洁");
    add("九万字", "黄诗扶");
    add("热气球", "黄淑惠");
    add("同桌的你", "胡夏");
    add("年轮", "张碧晨");
    add("红玫瑰", "张碧晨");
    add("连名带姓", "张惠妹");
    add("如果你也听说", "张惠妹");
    add("画心", "张靓颖");
    add("宝贝", "张悬");
    add("原谅", "张玉华");
    add("黑色毛衣", "周杰伦");
    add("退后", "周杰伦");
    add("枫", "周杰伦");
    add("烟花易冷", "周杰伦");
    add("明明就", "周杰伦");
    add("爱情废柴", "周杰伦");
    add("大鱼", "周深");
    return m;
  })();

  function playlistArtistForTitle(title) {
    var key = normalizePlaylistTitle(title);
    if (PLAYLIST_ARTIST_BY_TITLE[key]) return PLAYLIST_ARTIST_BY_TITLE[key];
    var lower = key.toLowerCase();
    if (PLAYLIST_ARTIST_BY_TITLE[lower]) return PLAYLIST_ARTIST_BY_TITLE[lower];
    return "";
  }

  function parseExtraPlaylistTitles(raw) {
    if (!raw || !String(raw).trim()) return [];
    var s = String(raw).replace(/落空说散就散/g, "落空，说散就散");
    var parts = s.split(/[，,]/);
    var out = [];
    var seen = {};
    for (var i = 0; i < parts.length; i++) {
      var t = normalizePlaylistTitle(parts[i]);
      if (!t) continue;
      if (seen[t]) continue;
      seen[t] = true;
      out.push(t);
    }
    return out;
  }

  function buildSampleSongs() {
    var baseByNorm = {};
    for (var i = 0; i < SAMPLE_SONGS_BASE.length; i++) {
      var br0 = SAMPLE_SONGS_BASE[i];
      baseByNorm[normalizePlaylistTitle(br0.title)] = br0;
    }

    var extraRaw =
      (typeof window !== "undefined" && window.JUKEBOX_EXTRA_PLAYLIST_TITLES) || "";
    var fromUser = parseExtraPlaylistTitles(extraRaw);

    var finalTitles = [];
    var seen = {};
    var u;
    for (u = 0; u < fromUser.length; u++) {
      var tu = fromUser[u];
      if (seen[tu]) continue;
      seen[tu] = true;
      finalTitles.push(tu);
    }

    var b;
    for (b = 0; b < SAMPLE_SONGS_BASE.length; b++) {
      var baseTit = normalizePlaylistTitle(SAMPLE_SONGS_BASE[b].title);
      if (seen[baseTit]) continue;
      seen[baseTit] = true;
      finalTitles.push(SAMPLE_SONGS_BASE[b].title);
    }

    var rows = [];
    for (var k = 0; k < finalTitles.length; k++) {
      var titleNorm = normalizePlaylistTitle(finalTitles[k]);
      var ord = k + 1;
      var suffix = ("000000000000" + String(100 + ord)).slice(-12);
      var baseRow = baseByNorm[titleNorm];
      if (baseRow) {
        var artistOv = playlistArtistForTitle(baseRow.title);
        rows.push({
          id: baseRow.id,
          title: baseRow.title,
          artist: artistOv || baseRow.artist,
          note: baseRow.note || "",
          link_url: baseRow.link_url || "",
          sort_order: ord,
        });
      } else {
        var artistEx = playlistArtistForTitle(finalTitles[k]);
        rows.push({
          id: "11111111-1111-4111-8111-" + suffix,
          title: finalTitles[k],
          artist: artistEx || SAMPLE_SONG_ARTISTS_CYCLE[k % SAMPLE_SONG_ARTISTS_CYCLE.length],
          note: "",
          link_url: "",
          sort_order: ord,
        });
      }
    }
    return rows;
  }

  global.RuinsPlaylistSamples = { buildSampleSongs: buildSampleSongs };
})(typeof window !== "undefined" ? window : this);
