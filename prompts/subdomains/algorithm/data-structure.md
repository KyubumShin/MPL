# Subdomain: Algorithm/Data-Structure (Data Structure Selection and Usage)

## Core Principles
- Choose data structures based on the time complexity and usage frequency of key operations (insert, delete, search, sort)
- Use Heap/Priority Queue for repeated min/max extraction — guarantees O(log n) insertion compared to sorted arrays
- Trie is well-suited for prefix search, autocomplete, and dictionary structures — saves space by sharing common prefixes across string sets
- Immutable structures prevent shared-state bugs at the source — use functional update patterns

## Cautions
- Understand hash table collision strategies (chaining vs. open addressing) — prevent worst-case O(n) lookup
- Watch for infinite loops caused by missing visited tracking in tree/graph traversal (cyclic graphs)
- The choice of serialization format (JSON, MessagePack, Protobuf) directly impacts size and parsing performance
- Limit maximum depth for recursive tree traversal — risk of stack overflow with deeply nested trees

## Verification Points
- Are the time/space complexities of the chosen data structure acceptable at the target data scale?
- Is cycle detection logic implemented with DFS visited tracking for graph traversal?
- Does the serialization format maintain schema version compatibility with the receiver?
- Is it verified with unit tests that immutable updates do not mutate the original structure?
