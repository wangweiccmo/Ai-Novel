export type ProjectTemplate = {
  id: string;
  title: string;
  genre: string;
  logline: string;
  world_setting: string;
  style_guide: string;
  constraints: string;
};

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "city-suspense",
    title: "都市悬疑",
    genre: "悬疑 / 都市",
    logline: "一宗旧案牵出连环迷局，真相藏在最熟悉的人群中。",
    world_setting: "现代一线城市，媒体与网络舆论推动案件发酵。",
    style_guide: "节奏紧凑，线索层层递进；善用视角切换与信息落差。",
    constraints: "目标字数：8-12 万字；章节字数：2500-3500；开篇 3 章内抛出核心谜题。",
  },
  {
    id: "fantasy-adventure",
    title: "奇幻冒险",
    genre: "奇幻 / 冒险",
    logline: "平凡少年意外卷入古老预言，与伙伴踏上禁域之旅。",
    world_setting: "多种族大陆，存在元素魔法与古代遗迹。",
    style_guide: "画面感强，强调探索与成长；每章以小高潮收束。",
    constraints: "目标字数：12-18 万字；章节字数：3000-4500；每 3-4 章推进一次主线阶段。",
  },
  {
    id: "cyber-noir",
    title: "赛博黑色",
    genre: "科幻 / 悬疑",
    logline: "黑客侦探追查消失的记忆芯片，牵出跨城阴谋。",
    world_setting: "近未来巨型都市，企业巨头掌控基础设施。",
    style_guide: "冷峻克制，细节密度高；对比人性与技术控制。",
    constraints: "目标字数：6-10 万字；章节字数：2500-3500；保持强烈的氛围与悬疑钩子。",
  },
  {
    id: "light-romance",
    title: "轻松言情",
    genre: "言情 / 日常",
    logline: "两个性格南辕北辙的人在职场里慢慢靠近。",
    world_setting: "都市职场 + 日常生活场景。",
    style_guide: "轻快幽默，人物对白有张力；注意节奏起伏。",
    constraints: "目标字数：6-9 万字；章节字数：2000-3200；每章结尾设置轻微情绪波动。",
  },
];

export const GENRE_TAGS = ["都市", "奇幻", "科幻", "言情", "悬疑", "历史", "武侠", "恐怖", "游戏"];
