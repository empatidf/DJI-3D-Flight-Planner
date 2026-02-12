#!/usr/bin/env python3
"""
Command-line interface for GeoTIFF tiling
Usage: python tile_cli.py <input_file> <output_dir>
"""

import sys
import json
from imagery_tiler import generate_tiles, cleanup_temp_files

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: python tile_cli.py <input_file> <output_dir>', file=sys.stderr)
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_dir = sys.argv[2]
    
    try:
        # Generate tiles
        result = generate_tiles(input_file, output_dir)
        
        # Cleanup temporary files
        cleanup_temp_files(output_dir)
        
        # Output result as JSON
        print('RESULT_JSON:' + json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
