// R43 approved menu. Price buys a package; restore applies to ONE portion.
const rows=[
 ['rice','白米饭',1,35,2,'碗'],['noodles','清汤面',1,35,2,'碗'],['steamed-bun','大馒头',1,35,2,'份'],['toast','吐司',1,35,3,'份'],['sandwich','三明治',1,35,3,'份'],
 ['chicken-bento','鸡肉便当',1,50,6,'盒'],['lanzhou-noodles','兰州拉面',1,50,6,'碗'],['fried-rice','蛋炒饭',1,50,6,'份'],['chive-pie','韭菜盒子',1,50,6,'份'],['chive-dumplings','韭菜鸡蛋水饺',1,50,6,'盘'],['deluxe-bento','豪华便当（含寿司）',1,50,10,'盒'],
 ['biscuit','小饼干',3,10,1,'小份'],['milk-candy','大白兔奶糖',3,10,1,'小份'],['crisps','薯片',2,15,1,'小份'],['fruit','水果拼盘',2,15,1,'小份'],['pudding','小布丁',2,15,1,'杯'],['chocolate','巧克力',2,15,1,'小份'],['ice-cream','甜筒冰激凌',1,15,2,'个'],['cheesecake','芝士蛋糕',1,15,3,'份'],['milk','牛奶',2,10,2,'盒'],['juice','果汁',2,10,2,'盒'],
];
export const FOODS=Object.freeze(rows.map(([id,name,portions,restore,price,unit])=>Object.freeze({id,name,portions,restore,price,unit,artwork:'functional-placeholder'})));
const index=new Map(FOODS.map(food=>[food.id,food]));
export function foodById(id){const food=index.get(id);if(!food)throw Object.assign(Error('食品不存在'),{code:'FOOD_UNKNOWN'});return food;}
