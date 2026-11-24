import copy
import unittest

from agents.request_graph import normalize_column_ids


class ColumnIdArgumentTests(unittest.TestCase):
    def setUp(self):
        self.context = {'workspace': {'columns': [
            {'column_id': value} for value in ['2', '3', '5', '6', '01']
        ]}}

    def test_only_existing_exact_integer_ids_are_normalized(self):
        for value in [1, 7, 2.0, True, None, '02', 'deleted']:
            with self.subTest(value=value):
                args = {'column_id': value, 'column_ids': [value]}
                self.assertEqual(normalize_column_ids(args, self.context), args)
        args = {'column_id': 2, 'column_ids': [3, 5, '01']}
        self.assertEqual(normalize_column_ids(args, self.context),
                         {'column_id': '2', 'column_ids': ['3', '5', '01']})
        self.assertEqual(normalize_column_ids(args, {}), args)

    def test_nested_identifiers_preserve_business_values_and_original_arguments(self):
        args = {'input_column_ids': [2, 3], 'destination_column_id': 5,
                'output': {'mode': 'existing', 'column_id': 5, 'score_column_id': 6},
                'condition': {'column_id': 6, 'value': 100},
                'similarity': {'column_id': 3, 'group_column_id': 5},
                'code': '00123', 'group': '2', 'assigned_value': 5,
                'mapping': {'column_id': 2}, 'threshold': 80}
        original = copy.deepcopy(args)
        result = normalize_column_ids(args, self.context)
        self.assertEqual(result['input_column_ids'], ['2', '3'])
        self.assertEqual(result['output']['score_column_id'], '6')
        self.assertEqual(result['condition'], {'column_id': '6', 'value': 100})
        self.assertEqual(result['similarity'], {'column_id': '3', 'group_column_id': '5'})
        for key in ['code', 'group', 'assigned_value', 'mapping', 'threshold']:
            self.assertEqual(result[key], original[key])
        self.assertEqual(args, original)
