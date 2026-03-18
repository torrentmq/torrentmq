class TorrentLRUNode<K, V> {
  key: K;
  value: V;
  prev: TorrentLRUNode<K, V> | null = null;
  next: TorrentLRUNode<K, V> | null = null;

  constructor(
    key: K,
    value: V,
    prev?: TorrentLRUNode<K, V>,
    next?: TorrentLRUNode<K, V>,
  ) {
    this.key = key;
    this.value = value;
    if (prev) this.prev = prev;
    if (next) this.next = next;
  }
}

export class TorrentLRUCache<K, V> {
  private capacity = 512;
  private map: Map<K, TorrentLRUNode<K, V>> = new Map();
  private head: TorrentLRUNode<K, V> | null = null;
  private tail: TorrentLRUNode<K, V> | null = null;
  private size = 0;

  constructor(capacity?: number) {
    if (capacity) this.capacity = capacity;
  }

  private remove(node: TorrentLRUNode<K, V>) {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;

    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;

    node.prev = null;
    node.next = null;

    this.size--;
  }

  private insert_at_head(node: TorrentLRUNode<K, V>) {
    node.next = this.head;
    node.prev = null;

    if (this.head) this.head.prev = node;
    this.head = node;

    if (!this.tail) this.tail = node;

    this.size++;
  }

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;

    // move node to head
    this.remove(node);
    this.insert_at_head(node);

    return node.value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V) {
    let node = this.map.get(key);

    if (node) {
      node.value = value;
      this.remove(node);
      this.insert_at_head(node);
      return;
    }

    // create new node
    node = new TorrentLRUNode(key, value);
    this.map.set(key, node);
    this.insert_at_head(node);

    // evict LRU
    if (this.map.size > this.capacity && this.tail) {
      const lru = this.tail;
      this.remove(lru);
      this.map.delete(lru.key);
    }
  }
}
